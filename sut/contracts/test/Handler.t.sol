// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OrderBookExchange} from "../src/OrderBookExchange.sol";
import {MockERC20} from "./MockERC20.sol";

/**
 * @dev Handler for the invariant suite.
 *
 * Foundry's invariant runner calls these functions with random arguments in a
 * random order. Unbounded random arguments spend the whole run reverting on
 * absurd inputs, so every argument is bounded into the range where the
 * contract actually does work, and every action targets a trader that exists.
 *
 * `ghostPlaced` and friends are not assertions. They record what the handler
 * asked for, so the invariants can check the contract against the sequence
 * that was actually driven rather than against a guess.
 */
contract Handler is Test {
    OrderBookExchange public immutable exchange;
    MockERC20 public immutable base;
    MockERC20 public immutable quote;

    address[] public traders;
    uint64[] public liveOrderIds;

    uint256 public ghostPlaced;
    /**
     * Arithmetic panics, counted separately from ordinary refusals.
     *
     * A blanket `catch` treats "you cannot afford this" and "the contract
     * underflowed" as the same event, and an invariant suite built on that
     * cannot tell a healthy refusal from a broken one. It passes by swallowing
     * the failure. See LESSONS.md.
     */
    uint256 public ghostPanics;
    uint256 public lastPanicCode;
    uint256 public ghostRefused;
    uint256 public ghostCancelled;
    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;

    constructor(OrderBookExchange _exchange, MockERC20 _base, MockERC20 _quote, address[] memory _traders) {
        exchange = _exchange;
        base = _base;
        quote = _quote;
        traders = _traders;
    }

    function _trader(uint256 seed) internal view returns (address) {
        return traders[seed % traders.length];
    }

    function placeOrder(uint256 traderSeed, bool isBuy, uint128 price, uint128 quantity) public {
        address trader = _trader(traderSeed);
        price = uint128(bound(price, 90, 110));
        quantity = uint128(bound(quantity, 1, 50));

        vm.prank(trader);
        try exchange.placeLimitOrder(isBuy, price, quantity) returns (uint64 orderId) {
            ghostPlaced++;
            // Every order gets an id; only one that rested can be cancelled.
            (address owner,,,,,) = exchange.orders(orderId);
            if (owner != address(0)) liveOrderIds.push(orderId);
        } catch Panic(uint256 code) {
            ghostPanics++;
            lastPanicCode = code;
        } catch {
            // A named revert is the contract refusing on purpose.
            ghostRefused++;
        }
    }

    function cancelOrder(uint256 orderSeed) public {
        if (liveOrderIds.length == 0) return;
        uint256 index = orderSeed % liveOrderIds.length;
        uint64 orderId = liveOrderIds[index];
        (address owner,,,,,) = exchange.orders(orderId);
        if (owner == address(0)) return;

        vm.prank(owner);
        try exchange.cancelOrder(orderId) {
            ghostCancelled++;
            liveOrderIds[index] = liveOrderIds[liveOrderIds.length - 1];
            liveOrderIds.pop();
        } catch Panic(uint256 code) {
            ghostPanics++;
            lastPanicCode = code;
        } catch {
            ghostRefused++;
        }
    }

    function depositQuote(uint256 traderSeed, uint256 amount) public {
        address trader = _trader(traderSeed);
        amount = bound(amount, 1, 1e24);
        quote.mint(trader, amount);
        vm.prank(trader);
        try exchange.depositQuote(amount) {
            ghostDeposited++;
        } catch {}
    }

    function withdrawQuote(uint256 traderSeed, uint256 amount) public {
        address trader = _trader(traderSeed);
        uint256 available = exchange.availableQuote(trader);
        if (available == 0) return;
        amount = bound(amount, 1, available);
        vm.prank(trader);
        try exchange.withdrawQuote(amount) {
            ghostWithdrawn++;
        } catch {}
    }

    function withdrawBase(uint256 traderSeed, uint256 amount) public {
        address trader = _trader(traderSeed);
        uint256 available = exchange.availableBase(trader);
        if (available == 0) return;
        amount = bound(amount, 1, available);
        vm.prank(trader);
        try exchange.withdrawBase(amount) {
            ghostWithdrawn++;
        } catch {}
    }

    function traderCount() external view returns (uint256) {
        return traders.length;
    }

    function traderAt(uint256 index) external view returns (address) {
        return traders[index];
    }
}
