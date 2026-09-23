// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

/**
 * @title OrderBookExchange
 * @notice A limit order book that matches and settles entirely onchain.
 *
 * Price levels are a doubly linked list ordered best-first per side; orders
 * within a level are a FIFO linked list. Matching walks the opposite side from
 * the best price, bounded by MAX_MATCH_STEPS so a single order can never
 * consume an unbounded amount of gas.
 *
 * Deliberately narrow: limit orders, good-till-cancelled, no stops, no icebergs
 * and no self-trade prevention. The richer order types live off-chain in the
 * sequencer and arrive here as the limit orders they resolve to. See
 * docs/NON-GOALS.md.
 *
 * Funds are escrowed on placement. A buy locks quote at its own limit price
 * plus the worst-case fee, so a fill at a better price refunds the difference.
 */
contract OrderBookExchange {
    // ------------------------------------------------------------- errors

    error ZeroQuantity();
    error ZeroPrice();
    error InsufficientBalance();
    error NotOrderOwner();
    error OrderNotFound();
    error TransferFailed();
    error NotionalOverflow();

    // ------------------------------------------------------------- events

    event Deposited(address indexed trader, address indexed token, uint256 amount);
    event Withdrawn(address indexed trader, address indexed token, uint256 amount);
    event OrderPlaced(
        uint64 indexed orderId, address indexed trader, bool isBuy, uint128 price, uint128 quantity
    );
    event OrderCancelled(uint64 indexed orderId, uint128 remaining);
    event Traded(
        uint64 indexed takerOrderId,
        uint64 indexed makerOrderId,
        bool takerIsBuy,
        uint128 price,
        uint128 quantity
    );

    // -------------------------------------------------------------- types

    struct Order {
        address trader;
        uint128 price;
        uint128 remaining;
        bool isBuy;
        uint64 next;
        uint64 prev;
    }

    struct Level {
        uint128 totalQuantity;
        uint64 head;
        uint64 tail;
        uint128 betterPrice;
        uint128 worsePrice;
        bool exists;
    }

    // ------------------------------------------------------------- storage

    /// @notice Cap on levels walked in one call, so gas stays bounded.
    uint256 public constant MAX_MATCH_STEPS = 64;
    uint256 private constant BPS = 10_000;

    IERC20 public immutable baseToken;
    IERC20 public immutable quoteToken;
    /// @notice Quote units per lot per tick.
    uint256 public immutable quoteScale;
    /// @notice Base units per lot.
    uint256 public immutable baseScale;
    uint256 public immutable makerFeeBps;
    uint256 public immutable takerFeeBps;
    address public immutable feeRecipient;

    mapping(address => uint256) public availableBase;
    mapping(address => uint256) public availableQuote;
    mapping(address => uint256) public lockedBase;
    mapping(address => uint256) public lockedQuote;

    mapping(uint64 => Order) public orders;
    mapping(bool => mapping(uint128 => Level)) private levels;
    /// @notice Best price per side: highest bid, lowest ask. Zero when empty.
    mapping(bool => uint128) public bestPrice;

    uint64 public nextOrderId = 1;

    constructor(
        IERC20 _baseToken,
        IERC20 _quoteToken,
        uint256 _quoteScale,
        uint256 _baseScale,
        uint256 _makerFeeBps,
        uint256 _takerFeeBps,
        address _feeRecipient
    ) {
        baseToken = _baseToken;
        quoteToken = _quoteToken;
        quoteScale = _quoteScale;
        baseScale = _baseScale;
        makerFeeBps = _makerFeeBps;
        takerFeeBps = _takerFeeBps;
        feeRecipient = _feeRecipient;
    }

    // ------------------------------------------------------------ funding

    function depositBase(uint256 amount) external {
        availableBase[msg.sender] += amount;
        emit Deposited(msg.sender, address(baseToken), amount);
        if (!baseToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
    }

    function depositQuote(uint256 amount) external {
        availableQuote[msg.sender] += amount;
        emit Deposited(msg.sender, address(quoteToken), amount);
        if (!quoteToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
    }

    function withdrawBase(uint256 amount) external {
        if (availableBase[msg.sender] < amount) revert InsufficientBalance();
        availableBase[msg.sender] -= amount;
        // Log before the external call: a reentrant token could otherwise
        // reorder or interleave the events off-chain consumers index on.
        emit Withdrawn(msg.sender, address(baseToken), amount);
        if (!baseToken.transfer(msg.sender, amount)) revert TransferFailed();
    }

    function withdrawQuote(uint256 amount) external {
        if (availableQuote[msg.sender] < amount) revert InsufficientBalance();
        availableQuote[msg.sender] -= amount;
        emit Withdrawn(msg.sender, address(quoteToken), amount);
        if (!quoteToken.transfer(msg.sender, amount)) revert TransferFailed();
    }

    // ------------------------------------------------------------- trading

    /**
     * @notice Place a good-till-cancelled limit order.
     * @return orderId Zero if the order filled completely and never rested.
     */
    function placeLimitOrder(bool isBuy, uint128 price, uint128 quantity)
        external
        returns (uint64 orderId)
    {
        if (quantity == 0) revert ZeroQuantity();
        if (price == 0) revert ZeroPrice();

        // Escrow up front at the order's own limit, plus the worse of the two
        // fee rates. A fill at a better price or as a maker refunds the excess.
        uint256 notionalAtLimit = _notional(quantity, price);
        uint256 feeLock = uint256(quantity) * _feePerLot(price);
        if (isBuy) {
            uint256 lock = notionalAtLimit + feeLock;
            if (availableQuote[msg.sender] < lock) revert InsufficientBalance();
            availableQuote[msg.sender] -= lock;
            lockedQuote[msg.sender] += lock;
        } else {
            uint256 lockBase = uint256(quantity) * baseScale;
            if (availableBase[msg.sender] < lockBase) revert InsufficientBalance();
            if (availableQuote[msg.sender] < feeLock) revert InsufficientBalance();
            availableBase[msg.sender] -= lockBase;
            lockedBase[msg.sender] += lockBase;
            availableQuote[msg.sender] -= feeLock;
            lockedQuote[msg.sender] += feeLock;
        }

        uint128 remaining = _match(isBuy, price, quantity);
        if (remaining == 0) {
            emit OrderPlaced(0, msg.sender, isBuy, price, quantity);
            return 0;
        }

        orderId = nextOrderId++;
        orders[orderId] =
            Order({trader: msg.sender, price: price, remaining: remaining, isBuy: isBuy, next: 0, prev: 0});
        _insert(isBuy, price, orderId, remaining);
        emit OrderPlaced(orderId, msg.sender, isBuy, price, quantity);
    }

    function cancelOrder(uint64 orderId) external {
        Order storage order = orders[orderId];
        if (order.trader == address(0)) revert OrderNotFound();
        if (order.trader != msg.sender) revert NotOrderOwner();

        uint128 remaining = order.remaining;
        _unlockFor(order.trader, order.isBuy, order.price, remaining);
        _unlink(order.isBuy, order.price, orderId);
        delete orders[orderId];
        emit OrderCancelled(orderId, remaining);
    }

    // ------------------------------------------------------------- views

    function levelAt(bool isBuy, uint128 price)
        external
        view
        returns (uint128 totalQuantity, uint64 head, bool exists)
    {
        Level storage level = levels[isBuy][price];
        return (level.totalQuantity, level.head, level.exists);
    }

    function nextWorsePrice(bool isBuy, uint128 price) external view returns (uint128) {
        return levels[isBuy][price].worsePrice;
    }

    // ------------------------------------------------------------ internal

    function _match(bool takerIsBuy, uint128 limitPrice, uint128 quantity)
        private
        returns (uint128 remaining)
    {
        remaining = quantity;
        bool makerSide = !takerIsBuy;

        for (uint256 step = 0; step < MAX_MATCH_STEPS && remaining > 0; step++) {
            uint128 makerPrice = bestPrice[makerSide];
            if (makerPrice == 0) break;
            if (takerIsBuy ? makerPrice > limitPrice : makerPrice < limitPrice) break;

            uint64 makerId = levels[makerSide][makerPrice].head;
            if (makerId == 0) break;

            Order storage maker = orders[makerId];
            uint128 fill = remaining < maker.remaining ? remaining : maker.remaining;

            _settle(takerIsBuy, msg.sender, maker.trader, makerPrice, limitPrice, fill);

            remaining -= fill;
            maker.remaining -= fill;
            levels[makerSide][makerPrice].totalQuantity -= fill;

            emit Traded(0, makerId, takerIsBuy, makerPrice, fill);

            if (maker.remaining == 0) {
                _unlink(makerSide, makerPrice, makerId);
                delete orders[makerId];
            }
        }
    }

    /**
     * @dev Move value for one fill. The taker's escrow was taken at its own
     * limit price; any difference from the execution price is returned here,
     * which is why a taker never pays more than it agreed to.
     */
    function _settle(
        bool takerIsBuy,
        address taker,
        address maker,
        uint128 execPrice,
        uint128 takerLimit,
        uint128 fill
    ) private {
        uint256 notional = uint256(fill) * execPrice * quoteScale;
        uint256 baseAmount = uint256(fill) * baseScale;
        uint256 takerFee = _ceilDiv(notional * takerFeeBps, BPS);
        uint256 makerFee = _ceilDiv(notional * makerFeeBps, BPS);
        // Release escrow by exactly the rule it was locked with: a ceiling per
        // lot at the price each order locked at. The taker locked at its own
        // limit; the maker rests at execPrice, so it locked at that. A single
        // ceiling over the whole fill is smaller than the sum of the per-lot
        // ceilings, and the difference used to stay locked forever.
        uint256 takerLockedFee = uint256(fill) * _feePerLot(takerLimit);
        uint256 makerLockedFee = uint256(fill) * _feePerLot(execPrice);

        if (takerIsBuy) {
            uint256 lockedAtLimit = uint256(fill) * takerLimit * quoteScale;
            lockedQuote[taker] -= lockedAtLimit + takerLockedFee;
            availableQuote[taker] += lockedAtLimit + takerLockedFee - notional - takerFee;
            availableBase[taker] += baseAmount;

            lockedBase[maker] -= baseAmount;
            lockedQuote[maker] -= makerLockedFee;
            availableQuote[maker] += notional + makerLockedFee - makerFee;
        } else {
            lockedBase[taker] -= baseAmount;
            lockedQuote[taker] -= takerLockedFee;
            availableQuote[taker] += notional + takerLockedFee - takerFee;

            lockedQuote[maker] -= notional + makerLockedFee;
            availableQuote[maker] += makerLockedFee - makerFee;
            availableBase[maker] += baseAmount;
        }

        availableQuote[feeRecipient] += takerFee + makerFee;
    }

    function _unlockFor(address trader, bool isBuy, uint128 price, uint128 remaining) private {
        uint256 notional = uint256(remaining) * price * quoteScale;
        uint256 feeLock = uint256(remaining) * _feePerLot(price);

        if (isBuy) {
            lockedQuote[trader] -= notional + feeLock;
            availableQuote[trader] += notional + feeLock;
        } else {
            uint256 baseAmount = uint256(remaining) * baseScale;
            lockedBase[trader] -= baseAmount;
            availableBase[trader] += baseAmount;
            lockedQuote[trader] -= feeLock;
            availableQuote[trader] += feeLock;
        }
    }

    function _insert(bool isBuy, uint128 price, uint64 orderId, uint128 quantity) private {
        Level storage level = levels[isBuy][price];
        if (!level.exists) {
            _linkLevel(isBuy, price);
            level.exists = true;
        }
        if (level.head == 0) {
            level.head = orderId;
            level.tail = orderId;
        } else {
            orders[level.tail].next = orderId;
            orders[orderId].prev = level.tail;
            level.tail = orderId;
        }
        level.totalQuantity += quantity;
    }

    /// @dev Walk the level list from the best price and splice the new one in.
    function _linkLevel(bool isBuy, uint128 price) private {
        uint128 best = bestPrice[isBuy];
        if (best == 0 || _isBetter(isBuy, price, best)) {
            levels[isBuy][price].worsePrice = best;
            if (best != 0) levels[isBuy][best].betterPrice = price;
            bestPrice[isBuy] = price;
            return;
        }
        uint128 cursor = best;
        while (true) {
            uint128 worse = levels[isBuy][cursor].worsePrice;
            if (worse == 0 || _isBetter(isBuy, price, worse)) {
                levels[isBuy][price].betterPrice = cursor;
                levels[isBuy][price].worsePrice = worse;
                levels[isBuy][cursor].worsePrice = price;
                if (worse != 0) levels[isBuy][worse].betterPrice = price;
                return;
            }
            cursor = worse;
        }
    }

    function _unlink(bool isBuy, uint128 price, uint64 orderId) private {
        Level storage level = levels[isBuy][price];
        Order storage order = orders[orderId];

        if (order.prev == 0) level.head = order.next;
        else orders[order.prev].next = order.next;

        if (order.next == 0) level.tail = order.prev;
        else orders[order.next].prev = order.prev;

        if (level.totalQuantity >= order.remaining) level.totalQuantity -= order.remaining;
        else level.totalQuantity = 0;

        if (level.head == 0) _unlinkLevel(isBuy, price);
    }

    function _unlinkLevel(bool isBuy, uint128 price) private {
        Level storage level = levels[isBuy][price];
        uint128 better = level.betterPrice;
        uint128 worse = level.worsePrice;

        if (better == 0) bestPrice[isBuy] = worse;
        else levels[isBuy][better].worsePrice = worse;
        if (worse != 0) levels[isBuy][worse].betterPrice = better;

        delete levels[isBuy][price];
    }

    function _isBetter(bool isBuy, uint128 a, uint128 b) private pure returns (bool) {
        return isBuy ? a > b : a < b;
    }

    /**
     * @dev Worst-case fee escrowed per lot at a given price.
     *
     * Escrow is taken for a whole order and released one fill at a time, so the
     * two calculations have to agree exactly. Rounding the fee up once on the
     * total does not agree: ceil(a + b) is not ceil(a) + ceil(b), so releasing
     * per fill can try to release more than was ever locked, and the subtraction
     * underflows. The order then cannot be filled or cancelled and the trader's
     * funds are stuck.
     *
     * Charging a ceiling per lot makes locking and releasing the same
     * arithmetic in a different order, which always balances, provided every
     * release uses this function too. It escrows slightly more than the fee
     * will be; the surplus returns to available balance on settlement.
     *
     * The first version of this fix released a single ceiling over each fill
     * instead, which is smaller, and stranded a unit or two per multi-lot fill.
     *
     * Found by the offchain/onchain differential suite on a market whose fees
     * do not divide evenly. See docs/FAILURE-MODES.md.
     */
    function _feePerLot(uint128 price) private view returns (uint256) {
        uint256 worstFeeBps = takerFeeBps > makerFeeBps ? takerFeeBps : makerFeeBps;
        return _ceilDiv(uint256(price) * quoteScale * worstFeeBps, BPS);
    }

    /**
     * @dev Notional with an explicit overflow guard.
     *
     * uint128 x uint128 fits in a uint256, but multiplying by quoteScale need
     * not. Without this the call reverts on an arithmetic panic, which tells
     * the caller nothing and looks identical to a contract bug. An order too
     * large to price is refused by name.
     */
    function _notional(uint128 quantity, uint128 price) private view returns (uint256) {
        uint256 product = uint256(quantity) * uint256(price);
        if (product != 0 && product > type(uint256).max / quoteScale) revert NotionalOverflow();
        return product * quoteScale;
    }

    function _ceilDiv(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        return numerator == 0 ? 0 : (numerator - 1) / denominator + 1;
    }
}
