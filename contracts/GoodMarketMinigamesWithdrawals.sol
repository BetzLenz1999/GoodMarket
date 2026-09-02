// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/**
 * @title GoodMarketMinigamesWithdrawals
 * @notice Voucher-based G$ withdrawals for GoodMarket Play & Earn.
 *
 * The server authorizes an exact, short-lived withdrawal off-chain. Normally
 * the player submits `claim` from their own wallet and therefore pays CELO
 * gas. Because the voucher binds the recipient, amount, id, chain and this
 * contract, a relayer may safely submit the same call if that player has no
 * CELO. A voucher is usable only once.
 */
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract GoodMarketMinigamesWithdrawals {
    IERC20Minimal public immutable goodDollarToken;
    address public owner;
    address public authorizationSigner;
    bool public paused;
    uint256 public dailyLimitPerUser = 1000 ether;
    mapping(bytes32 => bool) public withdrawalUsed;
    mapping(bytes32 => bool) public rewardSessionUsed;
    mapping(address => mapping(uint256 => uint256)) public rewardedPerDay;

    bytes32 private constant _DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant _CLAIM_TYPEHASH = keccak256(
        "Withdrawal(address recipient,uint256 amount,bytes32 withdrawalId,uint256 deadline)"
    );
    bytes32 private constant _NAME_HASH = keccak256("GoodMarket Minigames Withdrawals");
    bytes32 private constant _VERSION_HASH = keccak256("1");

    event WithdrawalClaimed(bytes32 indexed withdrawalId, address indexed recipient, uint256 amount, address indexed submittedBy);
    event AuthorizationSignerUpdated(address indexed signer);
    event Paused(bool paused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RewardDisbursed(address indexed recipient, uint256 amount, string sessionId);

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }
    modifier whenNotPaused() { require(!paused, "Withdrawals paused"); _; }
    modifier onlyAuthorizationSigner() { require(msg.sender == authorizationSigner, "Not authorized"); _; }

    constructor(address token, address signer) {
        require(token != address(0) && signer != address(0), "Invalid address");
        goodDollarToken = IERC20Minimal(token);
        owner = msg.sender;
        authorizationSigner = signer;
        emit OwnershipTransferred(address(0), msg.sender);
        emit AuthorizationSignerUpdated(signer);
    }

    function claim(
        address recipient,
        uint256 amount,
        bytes32 withdrawalId,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused {
        require(recipient != address(0) && amount > 0, "Invalid withdrawal");
        require(block.timestamp <= deadline, "Voucher expired");
        require(!withdrawalUsed[withdrawalId], "Withdrawal already claimed");
        require(_recover(_claimDigest(recipient, amount, withdrawalId, deadline), signature) == authorizationSigner, "Invalid voucher");
        require(goodDollarToken.balanceOf(address(this)) >= amount, "Insufficient G$ balance");

        // Set before the external token call to make the voucher non-reentrant.
        withdrawalUsed[withdrawalId] = true;
        require(goodDollarToken.transfer(recipient, amount), "G$ transfer failed");
        emit WithdrawalClaimed(withdrawalId, recipient, amount, msg.sender);
    }

    // Compatibility path for existing game-completion rewards. Withdrawals use
    // claim above; this is retained so deploying the revised contract does not
    // break already-shipped game reward calls.
    function disburseReward(address recipient, uint256 amount, string calldata sessionId) external onlyAuthorizationSigner whenNotPaused returns (bool) {
        bytes32 sessionHash = keccak256(bytes(sessionId));
        require(recipient != address(0) && amount > 0 && !rewardSessionUsed[sessionHash], "Invalid reward");
        uint256 day = block.timestamp / 1 days;
        require(rewardedPerDay[recipient][day] + amount <= dailyLimitPerUser, "Daily limit exceeded");
        require(goodDollarToken.balanceOf(address(this)) >= amount, "Insufficient G$ balance");
        rewardSessionUsed[sessionHash] = true;
        rewardedPerDay[recipient][day] += amount;
        require(goodDollarToken.transfer(recipient, amount), "G$ transfer failed");
        emit RewardDisbursed(recipient, amount, sessionId);
        return true;
    }

    function claimDigest(address recipient, uint256 amount, bytes32 withdrawalId, uint256 deadline) external view returns (bytes32) {
        return _claimDigest(recipient, amount, withdrawalId, deadline);
    }

    function getContractBalance() external view returns (uint256) { return goodDollarToken.balanceOf(address(this)); }
    function getRemainingDailyLimit(address user) external view returns (uint256) { uint256 used = rewardedPerDay[user][block.timestamp / 1 days]; return used >= dailyLimitPerUser ? 0 : dailyLimitPerUser - used; }
    function setAuthorizationSigner(address signer) external onlyOwner { require(signer != address(0), "Invalid signer"); authorizationSigner = signer; emit AuthorizationSignerUpdated(signer); }
    function setPaused(bool value) external onlyOwner { paused = value; emit Paused(value); }
    function updateDailyLimit(uint256 limit) external onlyOwner { require(limit > 0, "Invalid limit"); dailyLimitPerUser = limit; }
    function transferOwnership(address newOwner) external onlyOwner { require(newOwner != address(0), "Invalid owner"); emit OwnershipTransferred(owner, newOwner); owner = newOwner; }
    function rescueToken(address token, address to, uint256 amount) external onlyOwner { require(IERC20Minimal(token).transfer(to, amount), "Token transfer failed"); }

    function _claimDigest(address recipient, uint256 amount, bytes32 withdrawalId, uint256 deadline) private view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
        bytes32 claimHash = keccak256(abi.encode(_CLAIM_TYPEHASH, recipient, amount, withdrawalId, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domain, claimHash));
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        require(sig.length == 65, "Invalid signature length");
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(sig.offset) s := calldataload(add(sig.offset, 32)) v := byte(0, calldataload(add(sig.offset, 64))) }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Invalid signature v");
        require(uint256(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0, "Invalid signature s");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "Invalid signature");
        return signer;
    }
}
