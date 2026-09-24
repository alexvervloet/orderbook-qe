// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ExchangeTest} from "./Base.t.sol";
import {OrderBookExchange} from "../src/OrderBookExchange.sol";
import {Vm} from "forge-std/Vm.sol";

/// @dev Unit and fuzz tests. The invariant suite lives in Invariant.t.sol.
contract OrderBookExchangeTest is ExchangeTest {
    // ------------------------------------------------------------- funding

    function test_DepositCreditsAvailableBalance() public view {
        assertEq(exchange.availableBase(alice), 1e24);
        assertEq(exchange.availableQuote(alice), 1e30);
    }

    function test_WithdrawBeyondAvailableReverts() public {
        vm.prank(alice);
        vm.expectRevert(OrderBookExchange.InsufficientBalance.selector);
        exchange.withdrawBase(1e24 + 1);
    }

    function test_CannotWithdrawEscrowedFunds() public {
        _place(alice, false, 100, 1_000_000);
        uint256 available = exchange.availableBase(alice);

        vm.prank(alice);
        vm.expectRevert(OrderBookExchange.InsufficientBalance.selector);
        exchange.withdrawBase(available + 1);
    }

    function test_FailedTokenTransferRevertsAndKeepsCredit() public {
        uint256 before = exchange.availableBase(alice);
        base.setFailNextTransfer(true);

        vm.prank(alice);
        vm.expectRevert(OrderBookExchange.TransferFailed.selector);
        exchange.withdrawBase(1);

        // A token that returns false rather than reverting must not leave the
        // trader debited. This is the classic way funds go missing.
        assertEq(exchange.availableBase(alice), before);
    }

    // ------------------------------------------------------------ placing

    function test_RejectsZeroQuantity() public {
        vm.prank(alice);
        vm.expectRevert(OrderBookExchange.ZeroQuantity.selector);
        exchange.placeLimitOrder(true, 100, 0);
    }

    function test_RejectsZeroPrice() public {
        vm.prank(alice);
        vm.expectRevert(OrderBookExchange.ZeroPrice.selector);
        exchange.placeLimitOrder(true, 0, 1);
    }

    function test_RestingOrderEscrowsQuoteForABuy() public {
        uint256 availableBefore = exchange.availableQuote(alice);

        _place(alice, true, 100, 5);

        uint256 notional = uint256(5) * 100 * QUOTE_SCALE;
        uint256 fee = (notional * TAKER_FEE_BPS + 9_999) / 10_000;
        assertEq(exchange.lockedQuote(alice), notional + fee);
        assertEq(exchange.availableQuote(alice), availableBefore - notional - fee);
    }

    function test_PlacingBeyondBalanceReverts() public {
        vm.prank(alice);
        vm.expectRevert(OrderBookExchange.InsufficientBalance.selector);
        exchange.placeLimitOrder(true, 1e12, 1e15);
    }

    function test_AnUnpriceableOrderIsRefusedByName() public {
        // Found by test_PlacingBeyondBalanceReverts, which originally used the
        // maximum uint128 for both arguments and got an arithmetic panic
        // instead of a reason. See docs/FAILURE-MODES.md.
        vm.prank(alice);
        vm.expectRevert(OrderBookExchange.NotionalOverflow.selector);
        exchange.placeLimitOrder(true, type(uint128).max, type(uint128).max);
    }

    // ------------------------------------------------------------ matching

    function test_BestPriceTracksTheTopOfBook() public {
        _place(alice, true, 100, 1);
        _place(alice, true, 102, 1);
        _place(alice, true, 99, 1);

        assertEq(exchange.bestPrice(true), 102);
    }

    function test_MatchesAtTheMakerPriceGivingTheTakerImprovement() public {
        _place(bob, false, 101, 5);
        uint256 quoteBefore = exchange.availableQuote(alice);

        _place(alice, true, 105, 5);

        // Escrowed at 105, executed at 101. The difference must come back.
        uint256 executed = uint256(5) * 101 * QUOTE_SCALE;
        uint256 fee = (executed * TAKER_FEE_BPS + 9_999) / 10_000;
        assertEq(exchange.availableQuote(alice), quoteBefore - executed - fee);
        assertEq(exchange.lockedQuote(alice), 0);
        assertEq(exchange.availableBase(alice), 1e24 + uint256(5) * BASE_SCALE);
    }

    function test_FillsBestPriceFirstAcrossLevels() public {
        _place(bob, false, 103, 1);
        _place(bob, false, 101, 1);

        _place(alice, true, 105, 1);

        // The cheaper ask went first, so only the 103 level is left.
        assertEq(exchange.bestPrice(false), 103);
    }

    function test_FillsInQueueOrderWithinALevel() public {
        uint64 first = _place(bob, false, 101, 1);
        uint64 second = _place(carol, false, 101, 1);

        _place(alice, true, 101, 1);

        (,, bool firstExists) = _orderExists(first);
        (,, bool secondExists) = _orderExists(second);
        assertFalse(firstExists, "earlier order should have filled");
        assertTrue(secondExists, "later order should remain");
    }

    function test_PartialFillLeavesTheRemainderResting() public {
        _place(bob, false, 101, 2);

        _place(alice, true, 101, 5);

        (uint128 total,, bool exists) = exchange.levelAt(true, 101);
        assertTrue(exists);
        assertEq(total, 3);
    }

    function test_DoesNotCrossBeyondTheLimitPrice() public {
        _place(bob, false, 110, 5);

        _place(alice, true, 100, 5);

        // Both rest. The book is not crossed.
        assertEq(exchange.bestPrice(true), 100);
        assertEq(exchange.bestPrice(false), 110);
    }

    function test_EmptyLevelIsUnlinked() public {
        _place(bob, false, 101, 1);
        _place(bob, false, 103, 1);

        _place(alice, true, 101, 1);

        assertEq(exchange.bestPrice(false), 103);
        (,, bool exists) = exchange.levelAt(false, 101);
        assertFalse(exists);
    }

    // ----------------------------------------------------------- cancelling

    function test_CancelReturnsEscrow() public {
        uint256 before = exchange.availableQuote(alice);
        uint64 orderId = _place(alice, true, 100, 5);

        vm.prank(alice);
        exchange.cancelOrder(orderId);

        assertEq(exchange.availableQuote(alice), before);
        assertEq(exchange.lockedQuote(alice), 0);
    }

    function test_OnlyTheOwnerCanCancel() public {
        uint64 orderId = _place(alice, true, 100, 5);

        vm.prank(bob);
        vm.expectRevert(OrderBookExchange.NotOrderOwner.selector);
        exchange.cancelOrder(orderId);
    }

    function test_CancellingAnUnknownOrderReverts() public {
        vm.prank(alice);
        vm.expectRevert(OrderBookExchange.OrderNotFound.selector);
        exchange.cancelOrder(9999);
    }

    function test_CancelledOrderCannotFill() public {
        uint64 orderId = _place(alice, false, 100, 5);
        vm.prank(alice);
        exchange.cancelOrder(orderId);

        uint256 baseBefore = exchange.availableBase(bob);
        _place(bob, true, 100, 5);

        // Nothing to trade against, so bob's base is unchanged and he is resting.
        assertEq(exchange.availableBase(bob), baseBefore);
        assertEq(exchange.bestPrice(true), 100);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_SolvencyHoldsAfterAnyTrade(uint128 price, uint128 quantity) public {
        price = uint128(bound(price, 1, 10_000));
        quantity = uint128(bound(quantity, 1, 1_000));

        _place(bob, false, price, quantity);
        _place(alice, true, price, quantity);

        // Never owe more of either asset than the contract actually holds.
        assertLe(_totalOwedBase(), base.balanceOf(address(exchange)));
        assertLe(_totalOwedQuote(), quote.balanceOf(address(exchange)));
    }

    function testFuzz_CancelRestoresTheExactEscrow(uint128 price, uint128 quantity) public {
        price = uint128(bound(price, 1, 10_000));
        quantity = uint128(bound(quantity, 1, 1_000));

        uint256 quoteBefore = exchange.availableQuote(alice);
        uint256 baseBefore = exchange.availableBase(alice);

        uint64 orderId = _place(alice, true, price, quantity);
        vm.prank(alice);
        exchange.cancelOrder(orderId);

        // Placing and cancelling must be exactly value-neutral, to the unit.
        assertEq(exchange.availableQuote(alice), quoteBefore);
        assertEq(exchange.availableBase(alice), baseBefore);
    }

    function testFuzz_TakerNeverPaysMoreThanItsLimit(uint128 makerPrice, uint128 improvement)
        public
    {
        makerPrice = uint128(bound(makerPrice, 1, 10_000));
        improvement = uint128(bound(improvement, 0, 1_000));
        uint128 takerLimit = makerPrice + improvement;

        _place(bob, false, makerPrice, 10);
        uint256 quoteBefore = exchange.availableQuote(alice);

        _place(alice, true, takerLimit, 10);

        uint256 spent = quoteBefore - exchange.availableQuote(alice);
        uint256 atLimit = uint256(10) * takerLimit * QUOTE_SCALE;
        uint256 maxFee = (atLimit * TAKER_FEE_BPS + 9_999) / 10_000;
        assertLe(spent, atLimit + maxFee);
    }

    // --------------------------------------------------------- step limit

    /**
     * The match loop stops after MAX_MATCH_STEPS fills to bound gas. It used
     * to rest whatever was left at the order's limit, straight through the
     * asks it had not reached yet: a crossed book, onchain, where nobody can
     * patch it up after the fact.
     */
    function test_RefusesAnOrderThatWouldRestThroughTheStepLimit() public {
        uint256 steps = exchange.MAX_MATCH_STEPS();
        for (uint256 i = 0; i <= steps; i++) {
            _place(bob, false, 100, 1);
        }

        vm.prank(alice);
        vm.expectRevert(OrderBookExchange.MatchStepLimitReached.selector);
        exchange.placeLimitOrder(true, 100, uint128(steps + 1));

        // Refused whole: the book is untouched and the ask side is still best.
        (uint128 askDepth,,) = exchange.levelAt(false, 100);
        assertEq(askDepth, steps + 1);
        assertEq(exchange.bestPrice(true), 0, "nothing rested on the bid side");
    }

    function test_FillsRightUpToTheStepLimit() public {
        uint256 steps = exchange.MAX_MATCH_STEPS();
        for (uint256 i = 0; i < steps; i++) {
            _place(bob, false, 100, 1);
        }

        // Exactly as many fills as the limit allows, and the book is then
        // empty, so the remainder rests without crossing anything.
        _place(alice, true, 100, uint128(steps + 5));

        assertEq(exchange.bestPrice(false), 0, "every ask was taken");
        (uint128 bidDepth,,) = exchange.levelAt(true, 100);
        assertEq(bidDepth, 5);
    }

    function test_RefusesASellThatWouldRestThroughTheStepLimit() public {
        uint256 steps = exchange.MAX_MATCH_STEPS();
        for (uint256 i = 0; i <= steps; i++) {
            _place(bob, true, 100, 1);
        }

        // The sell side of the same check: bids still at exactly the limit.
        vm.prank(alice);
        vm.expectRevert(OrderBookExchange.MatchStepLimitReached.selector);
        exchange.placeLimitOrder(false, 100, uint128(steps + 1));
    }

    // ---------------------------------------------------- exact balances

    /**
     * Every balance check is `<`, so spending a balance down to exactly zero
     * must work. A `<=` there refuses a trader who can pay to the unit, and
     * mutation testing showed no test would notice.
     */
    function test_WithdrawsAnEntireBalance() public {
        uint256 baseBalance = exchange.availableBase(alice);
        uint256 quoteBalance = exchange.availableQuote(alice);

        vm.startPrank(alice);
        exchange.withdrawBase(baseBalance);
        exchange.withdrawQuote(quoteBalance);
        vm.stopPrank();

        assertEq(exchange.availableBase(alice), 0);
        assertEq(exchange.availableQuote(alice), 0);
    }

    function test_BuysWithExactlyEnoughQuote() public {
        address dave = address(0xDA7E);
        // One lot at 100: the notional, plus the worst-case fee per lot.
        uint256 lock = 100 * QUOTE_SCALE + (100 * QUOTE_SCALE * TAKER_FEE_BPS + 9_999) / 10_000;
        _fundExactly(dave, 0, lock);

        _place(dave, true, 100, 1);

        assertEq(exchange.availableQuote(dave), 0);
        assertEq(exchange.lockedQuote(dave), lock);
    }

    function test_SellsWithExactlyEnoughBaseAndFee() public {
        address dave = address(0xDA7E);
        uint256 feeLock = (100 * QUOTE_SCALE * TAKER_FEE_BPS + 9_999) / 10_000;
        _fundExactly(dave, BASE_SCALE, feeLock);

        _place(dave, false, 100, 1);

        assertEq(exchange.availableBase(dave), 0);
        assertEq(exchange.availableQuote(dave), 0);
    }

    // ------------------------------------------------------ settlement

    /// A maker buyer gets back the escrow above the fee it actually paid.
    function test_MakerBuyerPaysTheMakerFeeAndNoMore() public {
        uint256 before = exchange.availableQuote(alice);
        _place(alice, true, 100, 1);
        _place(bob, false, 100, 1);

        uint256 notional = 100 * QUOTE_SCALE;
        uint256 makerFee = (notional * MAKER_FEE_BPS + 9_999) / 10_000;
        assertEq(exchange.availableQuote(alice), before - notional - makerFee);
        assertEq(exchange.lockedQuote(alice), 0);
    }

    /**
     * A taker seller is credited the notional less the taker fee. Mutation
     * testing on CI found nothing deterministic checked this: flipping the
     * credit to a debit was killed locally by a lucky fuzz seed and survived
     * on another. A kill that depends on the seed is not a test.
     */
    function test_TakerSellerReceivesTheNotionalLessTheTakerFee() public {
        _place(alice, true, 100, 1);
        uint256 before = exchange.availableQuote(bob);
        _place(bob, false, 100, 1);

        uint256 notional = 100 * QUOTE_SCALE;
        uint256 takerFee = (notional * TAKER_FEE_BPS + 9_999) / 10_000;
        assertEq(exchange.availableQuote(bob), before + notional - takerFee);
        assertEq(exchange.lockedQuote(bob), 0);
    }

    /// Matching stops the moment the taker is filled, with one event per fill.
    function test_StopsMatchingOnceTheTakerIsFilled() public {
        _place(bob, false, 100, 1);
        _place(bob, false, 100, 1);

        vm.recordLogs();
        _place(alice, true, 100, 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 traded = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == OrderBookExchange.Traded.selector) traded++;
        }
        assertEq(traded, 1, "a filled taker kept matching");
        (uint128 depth,,) = exchange.levelAt(false, 100);
        assertEq(depth, 1);
    }

    // -------------------------------------------------------------- events

    /// Offchain indexers join trades to orders by id. Zero joins to nothing.
    function test_TradedCarriesTheTakerOrderId() public {
        uint64 makerId = _place(bob, false, 100, 1);
        uint64 expectedTakerId = exchange.nextOrderId();

        vm.expectEmit(true, true, false, true, address(exchange));
        emit OrderBookExchange.Traded(expectedTakerId, makerId, true, 100, 1);
        uint64 takerId = _place(alice, true, 100, 1);

        assertEq(takerId, expectedTakerId, "a filled order still reports its id");
    }

    // -------------------------------------------------------------- helpers

    function _fundExactly(address trader, uint256 baseAmount, uint256 quoteAmount) internal {
        base.mint(trader, baseAmount);
        quote.mint(trader, quoteAmount);
        vm.startPrank(trader);
        exchange.depositBase(baseAmount);
        exchange.depositQuote(quoteAmount);
        vm.stopPrank();
    }

    function _orderExists(uint64 orderId) internal view returns (address, uint128, bool) {
        (address trader, uint128 price,,,,) = exchange.orders(orderId);
        return (trader, price, trader != address(0));
    }
}
