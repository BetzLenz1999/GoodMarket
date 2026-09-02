// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ReferralRewards
 * @notice Custodies GoodDollar (or another ERC-20) and releases one approved
 *         referral reward per immutable reward id. Deploy this contract on Celo.
 *
 * Funding: transfer G$ directly to this contract address after deployment.
 * Payouts: the owner authorizes the backend operator; only that operator can
 *          call disburse. A reward id can be paid only once, even if backend
 *          retries or two workers submit the same referral concurrently.
 */
interface IERC20ReferralRewards {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract ReferralRewards {
    IERC20ReferralRewards public immutable token;
    address public owner;
    mapping(address => bool) public operators;
    mapping(bytes32 => bool) public rewardPaid;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorUpdated(address indexed operator, bool allowed);
    event RewardDisbursed(bytes32 indexed rewardId, address indexed recipient, uint256 amount, address operator);
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error RewardAlreadyPaid(bytes32 rewardId);
    error TokenTransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert Unauthorized();
        _;
    }

    constructor(address token_, address initialOperator_) {
        if (token_ == address(0) || initialOperator_ == address(0)) revert ZeroAddress();
        token = IERC20ReferralRewards(token_);
        owner = msg.sender;
        operators[initialOperator_] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit OperatorUpdated(initialOperator_, true);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        operators[operator] = allowed;
        emit OperatorUpdated(operator, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Pay a unique referral reward. State is updated before the token
    /// transfer; a token-transfer revert rolls back the entire transaction.
    function disburse(bytes32 rewardId, address recipient, uint256 amount) external onlyOperator {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (rewardPaid[rewardId]) revert RewardAlreadyPaid(rewardId);

        rewardPaid[rewardId] = true;
        if (!token.transfer(recipient, amount)) revert TokenTransferFailed();
        emit RewardDisbursed(rewardId, recipient, amount, msg.sender);
    }

    function availableBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Emergency recovery. G$ withdrawals are owner-only and should
    /// only be used after pausing/revoking backend operators operationally.
    function withdrawToken(address tokenAddress, address to, uint256 amount) external onlyOwner {
        if (tokenAddress == address(0) || to == address(0)) revert ZeroAddress();
        if (!IERC20ReferralRewards(tokenAddress).transfer(to, amount)) revert TokenTransferFailed();
        emit TokenWithdrawn(tokenAddress, to, amount);
    }
}
