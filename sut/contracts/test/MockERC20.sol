// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../src/IERC20.sol";

/// @dev Minimal token for tests. `failNextTransfer` exists so the exchange's
/// handling of a token that returns false can be exercised, which is a real
/// class of token and a real source of stuck funds.
contract MockERC20 is IERC20 {
    mapping(address => uint256) public balanceOf;
    bool public failNextTransfer;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFailNextTransfer(bool value) external {
        failNextTransfer = value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failNextTransfer) {
            failNextTransfer = false;
            return false;
        }
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failNextTransfer) {
            failNextTransfer = false;
            return false;
        }
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
