// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OrderBookExchange} from "../src/OrderBookExchange.sol";
import {IERC20} from "../src/IERC20.sol";
import {MockERC20} from "./MockERC20.sol";

/// @dev Shared fixture. Scales and fees match sut/backend/ledger.ts so the
/// onchain and off-chain settlement can be compared directly.
abstract contract ExchangeTest is Test {
    OrderBookExchange internal exchange;
    MockERC20 internal base;
    MockERC20 internal quote;

    address internal constant FEES = address(0xFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA401);

    uint256 internal constant QUOTE_SCALE = 10_000;
    uint256 internal constant BASE_SCALE = 1_000_000;
    uint256 internal constant MAKER_FEE_BPS = 2;
    uint256 internal constant TAKER_FEE_BPS = 7;

    function setUp() public virtual {
        base = new MockERC20();
        quote = new MockERC20();
        exchange = new OrderBookExchange(
            IERC20(address(base)),
            IERC20(address(quote)),
            QUOTE_SCALE,
            BASE_SCALE,
            MAKER_FEE_BPS,
            TAKER_FEE_BPS,
            FEES
        );
        _fund(alice);
        _fund(bob);
        _fund(carol);
    }

    function _fund(address trader) internal {
        base.mint(trader, 1e24);
        quote.mint(trader, 1e30);
        vm.startPrank(trader);
        exchange.depositBase(1e24);
        exchange.depositQuote(1e30);
        vm.stopPrank();
    }

    function _place(address trader, bool isBuy, uint128 price, uint128 quantity)
        internal
        returns (uint64 orderId)
    {
        vm.prank(trader);
        orderId = exchange.placeLimitOrder(isBuy, price, quantity);
    }

    /// @dev Every unit of each asset the exchange believes it owes anyone.
    function _totalOwedQuote() internal view returns (uint256 total) {
        address[4] memory traders = [alice, bob, carol, FEES];
        for (uint256 i = 0; i < traders.length; i++) {
            total += exchange.availableQuote(traders[i]) + exchange.lockedQuote(traders[i]);
        }
    }

    function _totalOwedBase() internal view returns (uint256 total) {
        address[4] memory traders = [alice, bob, carol, FEES];
        for (uint256 i = 0; i < traders.length; i++) {
            total += exchange.availableBase(traders[i]) + exchange.lockedBase(traders[i]);
        }
    }
}
