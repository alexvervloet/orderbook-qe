// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OrderBookExchange} from "../src/OrderBookExchange.sol";
import {IERC20} from "../src/IERC20.sol";
import {MockERC20} from "./MockERC20.sol";

/**
 * @dev Escrow arithmetic on a market whose fees do not divide evenly.
 *
 * The default market uses a quoteScale of 10,000 against a 10,000 basis-point
 * denominator, so every fee lands on a whole unit and rounding is invisible.
 * A quoteScale of 3 leaves a remainder, which is where the escrow accounting
 * has to be exactly right.
 *
 * Found by the offchain/onchain consistency suite, which shrank to four orders
 * on a market like this one. See docs/FAILURE-MODES.md.
 */
contract FeeRoundingTest is Test {
    OrderBookExchange internal exchange;
    MockERC20 internal base;
    MockERC20 internal quote;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint256 internal constant QUOTE_SCALE = 3;
    uint256 internal constant BASE_SCALE = 1_000_000;

    function setUp() public {
        base = new MockERC20();
        quote = new MockERC20();
        exchange = new OrderBookExchange(
            IERC20(address(base)), IERC20(address(quote)), QUOTE_SCALE, BASE_SCALE, 2, 7, address(0xFEE)
        );
        for (uint256 i = 0; i < 2; i++) {
            address trader = i == 0 ? alice : bob;
            base.mint(trader, 1e24);
            quote.mint(trader, 1e24);
            vm.startPrank(trader);
            exchange.depositBase(1e24);
            exchange.depositQuote(1e24);
            vm.stopPrank();
        }
    }

    /**
     * An order escrowed as a whole and released one fill at a time must not run
     * out of escrow partway through.
     *
     * ceil(a + b) is not ceil(a) + ceil(b). Locking the fee once on the total
     * and releasing it per fill can therefore release more than was ever taken,
     * and the difference underflows. The trader's remaining order becomes
     * impossible to fill or cancel: their funds are stuck.
     */
    function test_PartialFillsDoNotExhaustTheFeeEscrow() public {
        // Alice bids two lots at 99. Bob sells them to her one at a time.
        vm.prank(alice);
        uint64 orderId = exchange.placeLimitOrder(true, 99, 2);

        vm.prank(bob);
        exchange.placeLimitOrder(false, 99, 1);
        vm.prank(bob);
        exchange.placeLimitOrder(false, 99, 1);

        // Both lots filled, so the order is gone and nothing is left locked.
        (address owner,,,,,) = exchange.orders(orderId);
        assertEq(owner, address(0), "order should be fully filled");
        assertEq(exchange.lockedQuote(alice), 0, "escrow should be fully released");
    }

    /// The same shortfall, reached by cancelling the remainder instead.
    function test_CancelAfterAPartialFillReleasesTheRightEscrow() public {
        uint256 quoteBefore = exchange.availableQuote(alice);

        vm.prank(alice);
        uint64 orderId = exchange.placeLimitOrder(true, 99, 2);
        vm.prank(bob);
        exchange.placeLimitOrder(false, 99, 1);

        vm.prank(alice);
        exchange.cancelOrder(orderId);

        assertEq(exchange.lockedQuote(alice), 0, "escrow should be fully released");
        // Alice paid for exactly one lot plus its fee, and nothing is stranded.
        uint256 notional = uint256(1) * 99 * QUOTE_SCALE;
        uint256 fee = (notional * 7 + 9_999) / 10_000;
        assertEq(exchange.availableQuote(alice), quoteBefore - notional - fee);
    }
}
