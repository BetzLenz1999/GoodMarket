// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/**
 * @title MinigamesUserPaidWithdrawalVault
 * @notice G$ withdrawal vault with two deliberately separate paths:
 *         1. `claim`: the player submits the transaction and pays Celo gas.
 *         2. `claimFor`: an approved relayer submits a player-authorized
 *            transaction when that player cannot pay Celo gas.
 *
 * The game's balance remains authoritative off chain.  Before either call,
 * the backend must issue an EIP-712 `ClaimAuthorization` after atomically
 * reserving the player's available Minigames balance.  The nonce is consumed
 * on-chain, so an authorization can never pay twice.
 *
 * For the relayed path, the player additionally signs `RelayedClaimApproval`.
 * This prevents an authorized relayer from spending gas to send an unsolicited
 * payout merely because it has a backend authorization.
 *
 * This contract intentionally has no native-token receive/withdraw logic:
 * it holds G$ only.  Gas is paid by `msg.sender` (the player) or a configured
 * relayer wallet (for example the existing GAMES_KEY wallet).
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract MinigamesUserPaidWithdrawalVault {
    string public constant NAME = "GoodMarket Minigames Withdrawal Vault";
    string public constant VERSION = "1";

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant _CLAIM_AUTHORIZATION_TYPEHASH = keccak256(
        "ClaimAuthorization(address recipient,uint256 amount,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant _RELAYED_CLAIM_APPROVAL_TYPEHASH = keccak256(
        "RelayedClaimApproval(address recipient,uint256 amount,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant _NAME_HASH = keccak256(bytes(NAME));
    bytes32 private constant _VERSION_HASH = keccak256(bytes(VERSION));
    bytes32 private constant _SECP256K1N_DIV_2 =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    IERC20 public immutable goodDollar;
    address public owner;
    address public authorizer;
    mapping(address => bool) public relayers;
    mapping(address => uint256) public nonces;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AuthorizerUpdated(address indexed previousAuthorizer, address indexed newAuthorizer);
    event RelayerUpdated(address indexed relayer, bool allowed);
    event WithdrawalClaimed(
        address indexed recipient,
        uint256 amount,
        uint256 indexed nonce,
        address indexed submittedBy,
        bool relayed
    );

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error AuthorizationExpired();
    error InvalidNonce(uint256 expected, uint256 supplied);
    error InvalidSignature();
    error TokenTransferFailed();
    error InsufficientVaultBalance();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address goodDollar_, address authorizer_, address initialRelayer_) {
        if (goodDollar_ == address(0) || authorizer_ == address(0) || initialRelayer_ == address(0)) {
            revert ZeroAddress();
        }
        goodDollar = IERC20(goodDollar_);
        owner = msg.sender;
        authorizer = authorizer_;
        relayers[initialRelayer_] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit AuthorizerUpdated(address(0), authorizer_);
        emit RelayerUpdated(initialRelayer_, true);
    }

    /// @notice Player-paid path. msg.sender must be the recipient, so this
    ///         transaction is signed and gas-paid by the player's wallet.
    function claim(
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata authorization
    ) external {
        _validateAuthorization(msg.sender, amount, nonce, deadline, authorization);
        _payout(msg.sender, amount, nonce, false);
    }

    /// @notice Gas-sponsored fallback.  Only a configured relayer can submit
    ///         it, and both the backend authorizer and player must have signed.
    function claimFor(
        address recipient,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata authorization,
        bytes calldata playerApproval
    ) external {
        if (!relayers[msg.sender]) revert Unauthorized();
        _validateAuthorization(recipient, amount, nonce, deadline, authorization);
        bytes32 approvalDigest = _hashTypedData(
            keccak256(abi.encode(_RELAYED_CLAIM_APPROVAL_TYPEHASH, recipient, amount, nonce, deadline))
        );
        if (_recover(approvalDigest, playerApproval) != recipient) revert InvalidSignature();
        _payout(recipient, amount, nonce, true);
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        relayers[relayer] = allowed;
        emit RelayerUpdated(relayer, allowed);
    }

    function setAuthorizer(address newAuthorizer) external onlyOwner {
        if (newAuthorizer == address(0)) revert ZeroAddress();
        emit AuthorizerUpdated(authorizer, newAuthorizer);
        authorizer = newAuthorizer;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

    function _validateAuthorization(
        address recipient,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata authorization
    ) private view {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert AuthorizationExpired();
        if (nonce != nonces[recipient]) revert InvalidNonce(nonces[recipient], nonce);
        if (goodDollar.balanceOf(address(this)) < amount) revert InsufficientVaultBalance();
        bytes32 digest = _hashTypedData(
            keccak256(abi.encode(_CLAIM_AUTHORIZATION_TYPEHASH, recipient, amount, nonce, deadline))
        );
        if (_recover(digest, authorization) != authorizer) revert InvalidSignature();
    }

    function _payout(address recipient, uint256 amount, uint256 nonce, bool relayed) private {
        // Effects before interaction; an ERC-20 reversion rolls this increment back.
        nonces[recipient] = nonce + 1;
        if (!goodDollar.transfer(recipient, amount)) revert TokenTransferFailed();
        emit WithdrawalClaimed(recipient, amount, nonce, msg.sender, relayed);
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(
            _EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)
        ));
    }

    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > uint256(_SECP256K1N_DIV_2)) revert InvalidSignature();
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
