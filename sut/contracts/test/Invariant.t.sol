// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OrderBookExchange} from "../src/OrderBookExchange.sol";
import {IERC20} from "../src/IERC20.sol";
import {MockERC20} from "./MockERC20.sol";
import {Handler} from "./Handler.t.sol";

/**
 * @dev Properties that must hold after any sequence of exchange operations.
 *
 * These are the assertions worth having onchain. A unit test says one scenario
 * behaves; an invariant says no scenario the runner can construct breaks the
 * rule. Solvency in particular cannot be usefully tested by example, because
 * the way it breaks is always a sequence nobody wrote down.
 */
contract OrderBookInvariantTest is Test {
    OrderBookExchange internal exchange;
    MockERC20 internal base;
    MockERC20 internal quote;
    Handler internal handler;

    address internal constant FEES = address(0xFEE);
    uint256 internal constant BASE_SCALE = 1_000_000;
    uint256 internal constant WORST_FEE_BPS = 7;

    /**
     * Quote units per lot per tick. At 10,000 against a 10,000 basis-point
     * denominator every fee is a whole unit and rounding never happens, which
     * is how the escrow dust got past this suite. AwkwardScaleInvariantTest
     * reruns everything at 3.
     */
    function _quoteScale() internal pure virtual returns (uint256) {
        return 10_000;
    }

    function setUp() public {
        base = new MockERC20();
        quote = new MockERC20();
        exchange = new OrderBookExchange(
            IERC20(address(base)), IERC20(address(quote)), _quoteScale(), BASE_SCALE, 2, WORST_FEE_BPS, FEES
        );

        address[] memory traders = new address[](3);
        traders[0] = address(0xA11CE);
        traders[1] = address(0xB0B);
        traders[2] = address(0xCA401);
        for (uint256 i = 0; i < traders.length; i++) {
            base.mint(traders[i], 1e24);
            quote.mint(traders[i], 1e28);
            vm.startPrank(traders[i]);
            exchange.depositBase(1e24);
            exchange.depositQuote(1e28);
            vm.stopPrank();
        }

        handler = new Handler(exchange, base, quote, traders);
        targetContract(address(handler));
    }

    /**
     * Solvency. The contract must never believe it owes more of an asset than
     * it holds. Everything else on this list is a detail; this one is whether
     * the exchange can pay out.
     */
    function invariant_NeverOwesMoreBaseThanItHolds() public view {
        assertLe(_owed(true), base.balanceOf(address(exchange)));
    }

    function invariant_NeverOwesMoreQuoteThanItHolds() public view {
        assertLe(_owed(false), quote.balanceOf(address(exchange)));
    }

    /**
     * The book is never crossed. A crossed book means liquidity that should
     * have matched did not, and the next order to arrive gets a price that was
     * available to someone else first.
     */
    function invariant_BookIsNeverCrossed() public view {
        uint128 bestBid = exchange.bestPrice(true);
        uint128 bestAsk = exchange.bestPrice(false);
        if (bestBid == 0 || bestAsk == 0) return;
        assertLt(bestBid, bestAsk);
    }

    /**
     * Price levels stay sorted best-first. The linked list is maintained by
     * hand on every insert and removal, so it is exactly the kind of structure
     * that degrades quietly after a few thousand operations.
     */
    function invariant_BidLevelsDescend() public view {
        _assertOrdered(true);
    }

    function invariant_AskLevelsAscend() public view {
        _assertOrdered(false);
    }

    /**
     * Every level that exists holds at least one order, and its cached total
     * matches the orders actually linked into it. A level whose cached total
     * has drifted reports depth that cannot be traded against.
     */
    function invariant_LevelTotalsMatchTheirOrders() public view {
        for (uint256 side = 0; side < 2; side++) {
            bool isBuy = side == 0;
            uint128 price = exchange.bestPrice(isBuy);
            uint256 steps = 0;
            while (price != 0 && steps < 256) {
                (uint128 total, uint64 head, bool exists) = exchange.levelAt(isBuy, price);
                assertTrue(exists, "linked level must exist");
                assertTrue(head != 0, "existing level must hold an order");

                uint128 summed = 0;
                uint64 cursor = head;
                uint256 walked = 0;
                while (cursor != 0 && walked < 256) {
                    (, uint128 orderPrice, uint128 remaining,, uint64 next,) = exchange.orders(cursor);
                    assertEq(orderPrice, price, "order filed under the wrong price");
                    assertTrue(remaining > 0, "a resting order must have quantity left");
                    summed += remaining;
                    cursor = next;
                    walked++;
                }
                assertEq(total, summed, "cached level total drifted from its orders");

                price = exchange.nextWorsePrice(isBuy, price);
                steps++;
            }
        }
    }

    /**
     * Every unit locked belongs to an order that is still open, to the unit.
     *
     * Solvency only says the contract does not owe more than it holds. Funds
     * locked against nothing pass it, and they are just as lost to the trader:
     * no order is left to cancel, so nothing will ever release them. That is
     * what the per-fill fee rounding did.
     */
    function invariant_LockedFundsMatchOpenOrders() public view {
        uint64 lastId = exchange.nextOrderId();
        for (uint256 t = 0; t < handler.traderCount(); t++) {
            address trader = handler.traderAt(t);
            uint256 expectedQuote = 0;
            uint256 expectedBase = 0;
            for (uint64 id = 1; id < lastId; id++) {
                (address owner, uint128 price, uint128 remaining, bool isBuy,,) = exchange.orders(id);
                if (owner != trader) continue;
                uint256 feeLock = uint256(remaining) * _ceilDiv(uint256(price) * _quoteScale() * WORST_FEE_BPS, 10_000);
                if (isBuy) {
                    expectedQuote += uint256(remaining) * price * _quoteScale() + feeLock;
                } else {
                    expectedBase += uint256(remaining) * BASE_SCALE;
                    expectedQuote += feeLock;
                }
            }
            assertEq(exchange.lockedQuote(trader), expectedQuote, "quote locked against no open order");
            assertEq(exchange.lockedBase(trader), expectedBase, "base locked against no open order");
        }
    }

    /// The fee account only ever grows, and never holds base.
    function invariant_FeeAccountHoldsOnlyQuote() public view {
        assertEq(exchange.availableBase(FEES), 0);
        assertEq(exchange.lockedBase(FEES), 0);
        assertEq(exchange.lockedQuote(FEES), 0);
    }

    /**
     * No operation on bounded, affordable inputs may panic.
     *
     * Added after a mutant that removed the limit-price check survived the
     * whole suite. It made settlement underflow, the handler caught the revert
     * like any other refusal, and every invariant held on a book that had
     * stopped trading. An invariant suite whose handler swallows failures
     * measures nothing. See LESSONS.md.
     */
    function invariant_NoArithmeticPanics() public view {
        assertEq(handler.ghostPanics(), 0, "an operation panicked rather than refusing cleanly");
    }

    /// Reported so a run that exercised nothing is visible rather than green.
    function invariant_CallSummary() public view {
        console2.log("placed", handler.ghostPlaced());
        console2.log("cancelled", handler.ghostCancelled());
        console2.log("deposited", handler.ghostDeposited());
        console2.log("withdrawn", handler.ghostWithdrawn());
        console2.log("refused", handler.ghostRefused());
        console2.log("panics", handler.ghostPanics());
    }

    /**
     * The handler must be able to trade. A handler that refuses everything
     * satisfies every property above and proves nothing.
     *
     * This used to be an `afterInvariant` asserting that every run placed an
     * order. That is not true of a healthy run: a run whose calls are all
     * withdrawals, or that withdraws a trader dry first, places nothing, and
     * the check failed about one run in five. Worse, Foundry persists a failed
     * sequence and replays it, so one bad draw failed every run after it. What
     * the check was guarding against is a handler that swallows funded orders,
     * and that is a deterministic question with a deterministic test.
     */
    function test_HandlerPlacesAFundedOrder() public {
        handler.placeOrder(0, true, 100, 1);
        handler.placeOrder(1, false, 100, 1);

        assertEq(handler.ghostPlaced(), 2, "the handler swallowed a funded order");
        assertEq(handler.ghostRefused(), 0, "a funded order was refused");
        assertEq(exchange.bestPrice(true), 0, "the two orders should have traded");
    }

    // -------------------------------------------------------------- helpers

    function _owed(bool isBase) internal view returns (uint256 total) {
        for (uint256 i = 0; i < handler.traderCount(); i++) {
            address trader = handler.traderAt(i);
            total += isBase
                ? exchange.availableBase(trader) + exchange.lockedBase(trader)
                : exchange.availableQuote(trader) + exchange.lockedQuote(trader);
        }
        total += isBase
            ? exchange.availableBase(FEES) + exchange.lockedBase(FEES)
            : exchange.availableQuote(FEES) + exchange.lockedQuote(FEES);
    }

    function _ceilDiv(uint256 numerator, uint256 denominator) internal pure returns (uint256) {
        return numerator == 0 ? 0 : (numerator - 1) / denominator + 1;
    }

    function _assertOrdered(bool isBuy) internal view {
        uint128 price = exchange.bestPrice(isBuy);
        uint256 steps = 0;
        while (price != 0 && steps < 256) {
            uint128 worse = exchange.nextWorsePrice(isBuy, price);
            if (worse == 0) return;
            if (isBuy) assertGt(price, worse, "bid levels out of order");
            else assertLt(price, worse, "ask levels out of order");
            price = worse;
            steps++;
        }
    }
}

import {console2} from "forge-std/console2.sol";

/// @dev The same properties on a market whose fees do not divide evenly.
contract AwkwardScaleInvariantTest is OrderBookInvariantTest {
    function _quoteScale() internal pure override returns (uint256) {
        return 3;
    }
}
