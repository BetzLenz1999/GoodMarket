// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IGoodMarketLottoToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title GoodMarketLotto
 * @notice Daily 3-digit lottery prize vault (GoodMarket), PCSO-style: the
 *         player picks three digits 0-9 in a fixed order and the daily draw
 *         publishes three digits in a fixed order. Exact order wins the
 *         "straight" tier; the same three digits in any other order wins the
 *         lower "rumble" tier.
 *
 * The contract is a *prize vault* only: it holds G$ that the team deposited,
 * records which wallets may claim how much for a given round, and lets each
 * winner PULL their prize. Pull-based claiming means distribution can never be
 * blocked by one wallet (same model as GoodMarketRaffle.withdrawReward) and
 * each winner pays their own CELO gas.
 *
 * Winner selection is deliberately OFF-CHAIN: the server runs the daily draw,
 * computes winners/amounts from an admin-editable prize-tiers table, then the
 * draw scheduler calls grantWinners() as the configured owner. The contract
 * cannot be used to "inject" winners — only the owner key can grant, and the
 * grant amount per winner is bounded by the on-chain balances available.
 *
 * Vault-empty handling: claim() merely reverts when the contract no longer has
 * the G$ to pay. The app translates that revert into a friendly "the prize
 * vault is being refilled — please wait a few days" message, alerts the
 * proposer/admin, and lets winners withdraw automatically once the vault is
 * topped up (claim() is re-runnable — nothing marks it claimed until the
 * transfer succeeds).
 */
contract GoodMarketLotto {
    enum RoundStatus {
        None,      // round id not seen yet
        Finalized, // winning numbers recorded, grants can be added
        Claimable  // (no longer used; kept for ABI stability)
    }

    IGoodMarketLottoToken public immutable gdToken;
    address public immutable owner;
    uint256 public constant MAX_ROUNDS = 1024; // bound on grants per round batch

    uint256 public constant POSITIONS = 3;

    uint256 public latestRoundId;

    struct Round {
        RoundStatus status;
        uint256[3] winningNumbers;
        uint256 finalizedAt;
    }

    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => uint256)) public claimable; // G$ wei
    mapping(uint256 => mapping(address => bool))    public claimed;

    event RoundFinalized(uint256 indexed roundId, uint256[3] numbers);
    event WinnerGranted(uint256 indexed roundId, address indexed winner, uint256 amount);
    event RewardWithdrawn(uint256 indexed roundId, address indexed winner, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not_owner");
        _;
    }

    constructor(address gdTokenAddress) {
        require(gdTokenAddress != address(0), "zero_gd_token");
        gdToken = IGoodMarketLottoToken(gdTokenAddress);
        owner = msg.sender;
    }

    /// @notice Records the drawn digits for a round (order matters). Called by
    ///         the draw scheduler before grants so the final digits are on-chain.
    function finalizeRound(uint256 roundId, uint256[3] calldata numbers) external onlyOwner {
        require(roundId > latestRoundId, "stale_round");
        for (uint256 i = 0; i < 3; i++) {
            require(numbers[i] <= 9, "out_of_range"); // digits 0..9 (0 is valid)
        }
        Round storage round = rounds[roundId];
        round.status = RoundStatus.Finalized;
        round.winningNumbers = numbers;
        round.finalizedAt = block.timestamp;
        latestRoundId = roundId;
        emit RoundFinalized(roundId, numbers);
    }

    /// @notice Grants claimable prizes for a round. amountsWei must equal
    ///         winners.length. Can be called multiple times (e.g. to top up a
    ///         partial grant after the vault is refilled) — already-granted
    ///         winners are simply overwritten.
    function grantWinners(uint256 roundId, address[] calldata winners, uint256[] calldata amountsWei)
        external
        onlyOwner
    {
        Round storage round = rounds[roundId];
        require(round.status == RoundStatus.Finalized, "round_not_finalized");
        require(winners.length == amountsWei.length, "length_mismatch");
        require(winners.length <= MAX_ROUNDS, "too_many");

        for (uint256 i = 0; i < winners.length; i++) {
            address winner = winners[i];
            uint256 amount = amountsWei[i];
            require(winner != address(0), "zero_winner");
            require(amount > 0, "zero_amount");
            claimable[roundId][winner] = amount;
            emit WinnerGranted(roundId, winner, amount);
        }
    }

    /// @notice Winner pulls their prize. Reverts (matching ethers' revert-data
    ///         handling) when the vault lacks G$; the app turns that revert
    ///         into the "vault being refilled" message. Nothing is marked
    ///         claimed until the transfer succeeds, so a retry after a top-up
    ///         works without any admin step (the "magic withdraw").
    function claim(uint256 roundId) external returns (bool) {
        uint256 amount = claimable[roundId][msg.sender];
        require(amount > 0, "no_reward");
        require(!claimed[roundId][msg.sender], "already_claimed");

        bool ok = gdToken.transfer(msg.sender, amount);
        require(ok, "gd_transfer_failed");

        claimed[roundId][msg.sender] = true;
        claimable[roundId][msg.sender] = 0;

        emit RewardWithdrawn(roundId, msg.sender, amount);
        return true;
    }

    /// @notice Current G$ held by the vault (used by the UI + grant preflight).
    function contractBalance() external view returns (uint256) {
        return gdToken.balanceOf(address(this));
    }
}
