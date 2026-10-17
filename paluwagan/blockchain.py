"""
Paluwagan (community rotating savings) on-chain read service.

READ-ONLY by design: every state-changing action (create / join / activate /
contribute / claim) is signed by the user's own wallet in the browser. This
module only reads contract state and reconstructs history from emitted events,
so the contract is the single authoritative record (no off-chain database).

The contract is fully separate from GDSavings: different address, different
token custody, different accounting. Nothing here reads or writes savings state.
"""
from env_utils import get_env_int
import os
import logging
import threading

from web3 import Web3

logger = logging.getLogger(__name__)

CELO_RPC_URL = os.getenv('CELO_RPC_URL', 'https://forno.celo.org')
CELO_RPC_URLS = tuple(
    url.strip()
    for url in (
        os.getenv('CELO_RPC_URLS', '')
        or ','.join([
            CELO_RPC_URL,
            'https://1rpc.io/celo',
            'https://celo.publicnode.com',
        ])
    ).split(',')
    if url.strip()
)
CHAIN_ID = get_env_int('CHAIN_ID', 42220)

# Deployed address is configured per environment. No default — an unset address
# means the feature is not deployed yet, and the routes degrade gracefully.
PALUWAGAN_CONTRACT_ADDRESS = (os.getenv('PALUWAGAN_CONTRACT', '') or '').strip()
# Block the contract was deployed at; the lower bound for the event scan.
PALUWAGAN_DEPLOYMENT_BLOCK = get_env_int('PALUWAGAN_DEPLOYMENT_BLOCK', 0)

# v1 supports G$ only. Kept as a single-entry registry so v2 can extend it
# without touching the read paths.
GD_TOKEN_ADDRESS = os.getenv(
    'GOODDOLLAR_CONTRACT_ADDRESS',
    '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A',
)
SUPPORTED_TOKENS = {
    GD_TOKEN_ADDRESS.lower(): {"symbol": "G$", "decimals": 18},
}

# Group status enum must match the Solidity enum order.
GROUP_STATUS = {0: "none", 1: "forming", 2: "active", 3: "completed", 4: "settled"}
MEMBERS = 5
ROUND_DURATION = 7 * 24 * 3600
GRACE_PERIOD = 2 * 24 * 3600

# forno rejects eth_getLogs beyond ~5000 blocks; keep chunks under that.
GETLOGS_MAX_CHUNK = get_env_int("GETLOGS_MAX_CHUNK", 4000)

PALUWAGAN_ABI = [
    # ── Constants / state ──────────────────────────────────────────────────
    {"inputs": [], "name": "MEMBERS", "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "nextGroupId", "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "groupCount", "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"},
    # ── Views ──────────────────────────────────────────────────────────────
    {
        "inputs": [{"internalType": "uint256", "name": "groupId", "type": "uint256"}],
        "name": "getGroup",
        "outputs": [
            {"internalType": "address", "name": "token", "type": "address"},
            {"internalType": "uint256", "name": "contributionAmount", "type": "uint256"},
            {"internalType": "uint256", "name": "weeks", "type": "uint256"},
            {"internalType": "uint8", "name": "status", "type": "uint8"},
            {"internalType": "uint256", "name": "currentRound", "type": "uint256"},
            {"internalType": "uint256", "name": "roundStartAt", "type": "uint256"},
            {"internalType": "uint256", "name": "memberCount", "type": "uint256"},
            {"internalType": "uint256", "name": "roundDeadline", "type": "uint256"},
            {"internalType": "uint256", "name": "graceDeadline", "type": "uint256"},
        ],
        "stateMutability": "view",
        "type": "function",
    },
    {"inputs": [{"internalType": "uint256", "name": "groupId", "type": "uint256"}], "name": "getMembers", "outputs": [{"internalType": "address[5]", "name": "", "type": "address[5]"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"internalType": "uint256", "name": "groupId", "type": "uint256"}], "name": "getPayoutOrder", "outputs": [{"internalType": "uint8[5]", "name": "", "type": "uint8[5]"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"internalType": "uint256", "name": "groupId", "type": "uint256"}, {"internalType": "uint256", "name": "round", "type": "uint256"}], "name": "recipientOf", "outputs": [{"internalType": "address", "name": "", "type": "address"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"internalType": "uint256", "name": "groupId", "type": "uint256"}, {"internalType": "uint256", "name": "round", "type": "uint256"}], "name": "isPoolComplete", "outputs": [{"internalType": "bool", "name": "", "type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"internalType": "uint256", "name": "groupId", "type": "uint256"}, {"internalType": "address", "name": "account", "type": "address"}], "name": "isMemberOf", "outputs": [{"internalType": "bool", "name": "", "type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"internalType": "uint256", "name": "groupId", "type": "uint256"}, {"internalType": "uint256", "name": "round", "type": "uint256"}, {"internalType": "address", "name": "member", "type": "address"}], "name": "paid", "outputs": [{"internalType": "bool", "name": "", "type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"internalType": "uint256", "name": "groupId", "type": "uint256"}, {"internalType": "uint256", "name": "round", "type": "uint256"}], "name": "roundCollected", "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"},
    {
        "inputs": [{"internalType": "uint256", "name": "groupId", "type": "uint256"}, {"internalType": "uint256", "name": "round", "type": "uint256"}],
        "name": "payouts",
        "outputs": [
            {"internalType": "address", "name": "recipient", "type": "address"},
            {"internalType": "uint256", "name": "amount", "type": "uint256"},
            {"internalType": "bool", "name": "claimed", "type": "bool"},
        ],
        "stateMutability": "view",
        "type": "function",
    },
    {"inputs": [{"internalType": "uint256", "name": "groupId", "type": "uint256"}, {"internalType": "address", "name": "member", "type": "address"}], "name": "missedRounds", "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"internalType": "uint256", "name": "groupId", "type": "uint256"}, {"internalType": "address", "name": "member", "type": "address"}], "name": "consecutiveMisses", "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"internalType": "uint256", "name": "groupId", "type": "uint256"}, {"internalType": "address", "name": "member", "type": "address"}], "name": "isDefaulted", "outputs": [{"internalType": "bool", "name": "", "type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"internalType": "uint256", "name": "groupId", "type": "uint256"}], "name": "contractBalance", "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"},
    # ── Events (history is reconstructed from these) ───────────────────────
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "uint256", "name": "groupId", "type": "uint256"}, {"indexed": True, "internalType": "address", "name": "creator", "type": "address"}, {"indexed": True, "internalType": "address", "name": "token", "type": "address"}, {"indexed": False, "internalType": "uint256", "name": "contributionAmount", "type": "uint256"}, {"indexed": False, "internalType": "uint256", "name": "periodWeeks", "type": "uint256"}], "name": "GroupCreated", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "uint256", "name": "groupId", "type": "uint256"}, {"indexed": True, "internalType": "address", "name": "member", "type": "address"}, {"indexed": False, "internalType": "uint256", "name": "slot", "type": "uint256"}], "name": "MemberJoined", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "uint256", "name": "groupId", "type": "uint256"}, {"indexed": False, "internalType": "uint256", "name": "activatedAt", "type": "uint256"}, {"indexed": False, "internalType": "uint256", "name": "roundStartAt", "type": "uint256"}], "name": "GroupActivated", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "uint256", "name": "groupId", "type": "uint256"}, {"indexed": True, "internalType": "uint256", "name": "round", "type": "uint256"}, {"indexed": True, "internalType": "address", "name": "member", "type": "address"}, {"indexed": False, "internalType": "uint256", "name": "amount", "type": "uint256"}], "name": "ContributionMade", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "uint256", "name": "groupId", "type": "uint256"}, {"indexed": True, "internalType": "uint256", "name": "round", "type": "uint256"}, {"indexed": True, "internalType": "address", "name": "member", "type": "address"}, {"indexed": False, "internalType": "uint256", "name": "amount", "type": "uint256"}], "name": "ContributionLate", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "uint256", "name": "groupId", "type": "uint256"}, {"indexed": True, "internalType": "uint256", "name": "round", "type": "uint256"}, {"indexed": True, "internalType": "address", "name": "member", "type": "address"}, {"indexed": False, "internalType": "address", "name": "payer", "type": "address"}, {"indexed": False, "internalType": "uint256", "name": "amount", "type": "uint256"}], "name": "ContributionCovered", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "uint256", "name": "groupId", "type": "uint256"}, {"indexed": True, "internalType": "uint256", "name": "round", "type": "uint256"}, {"indexed": True, "internalType": "address", "name": "member", "type": "address"}], "name": "MemberMissed", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "uint256", "name": "groupId", "type": "uint256"}, {"indexed": True, "internalType": "address", "name": "member", "type": "address"}], "name": "MemberDefaulted", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "uint256", "name": "groupId", "type": "uint256"}, {"indexed": False, "internalType": "uint256", "name": "newRound", "type": "uint256"}], "name": "RoundAdvanced", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "uint256", "name": "groupId", "type": "uint256"}, {"indexed": True, "internalType": "uint256", "name": "round", "type": "uint256"}, {"indexed": True, "internalType": "address", "name": "recipient", "type": "address"}, {"indexed": False, "internalType": "uint256", "name": "amount", "type": "uint256"}], "name": "PayoutClaimed", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "uint256", "name": "groupId", "type": "uint256"}], "name": "GroupCompleted", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "uint256", "name": "groupId", "type": "uint256"}, {"indexed": True, "internalType": "address", "name": "proposer", "type": "address"}], "name": "EarlySettleProposed", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "uint256", "name": "groupId", "type": "uint256"}, {"indexed": True, "internalType": "address", "name": "member", "type": "address"}, {"indexed": False, "internalType": "uint256", "name": "approvals", "type": "uint256"}], "name": "EarlySettleApproved", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "uint256", "name": "groupId", "type": "uint256"}, {"indexed": False, "internalType": "uint256", "name": "perMember", "type": "uint256"}], "name": "GroupSettled", "type": "event"},
]

# ERC-20 fragments used by the user-signed contribution flow.
ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
]

_w3_pool = {}
_w3_lock = threading.Lock()


def is_configured():
    """True when a paluwagan contract address is configured for this deploy."""
    return bool(PALUWAGAN_CONTRACT_ADDRESS)


def get_w3():
    with _w3_lock:
        urls = list(CELO_RPC_URLS) or [CELO_RPC_URL]
        for url in urls:
            w3 = _w3_pool.get(url)
            if w3 is None:
                w3 = Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 8}))
                _w3_pool[url] = w3
            try:
                if w3.is_connected():
                    return w3
            except Exception:
                continue
        fallback = urls[0]
        return _w3_pool.setdefault(
            fallback,
            Web3(Web3.HTTPProvider(fallback, request_kwargs={"timeout": 8})),
        )


def get_contract(w3=None):
    if not PALUWAGAN_CONTRACT_ADDRESS:
        raise ValueError("PALUWAGAN_CONTRACT not set")
    w3 = w3 or get_w3()
    return w3.eth.contract(
        address=Web3.to_checksum_address(PALUWAGAN_CONTRACT_ADDRESS),
        abi=PALUWAGAN_ABI,
    )


def _token_meta(addr):
    if not addr:
        return {"symbol": "?", "decimals": 18}
    return SUPPORTED_TOKENS.get(str(addr).lower(), {"symbol": "?", "decimals": 18})


def _raw_to_human(raw, decimals):
    try:
        d = int(decimals) if decimals is not None else 18
        if d < 0:
            d = 18
        return float(int(raw)) / float(10 ** d)
    except Exception:
        return 0.0


def _chunked_logs(contract, event_name, from_block, to_block, argument_filters=None, step=None):
    """Pull event logs in chunks under forno's eth_getLogs range cap.

    Mirrors savings/blockchain.py's _chunked_event_logs: on a range error the
    chunk is halved and retried; a genuine failure is surfaced (never silently
    dropped, which is what previously made savings history look empty).
    """
    event = getattr(contract.events, event_name)
    logs = []
    start = int(from_block)
    end = int(to_block)
    if step is None:
        step = max(10_000, int(GETLOGS_MAX_CHUNK))
    while start <= end:
        stop = min(start + step - 1, end)
        try:
            logs.extend(event.get_logs(
                argument_filters=argument_filters or {},
                from_block=start,
                to_block=stop,
            ))
        except Exception:
            if step > 10_000:
                return _chunked_logs(
                    contract, event_name, start, end, argument_filters, step // 2
                )
            raise
        start = stop + 1
    return logs


def _from_block():
    if PALUWAGAN_DEPLOYMENT_BLOCK > 0:
        return PALUWAGAN_DEPLOYMENT_BLOCK
    # No configured deployment block: scan a bounded recent window rather than
    # genesis. Callers can force a wider scan by setting the env var.
    w3 = get_w3()
    latest = w3.eth.block_number
    return max(0, latest - get_env_int('PALUWAGAN_LOOKBACK_BLOCKS', 500_000))


def _tx_hash_hex(log):
    h = log["transactionHash"]
    return h.hex() if hasattr(h, "hex") else str(h)


def get_group(group_id):
    """Read a single group's live state from the contract."""
    contract = get_contract()
    g = contract.functions.getGroup(int(group_id)).call()
    token, contribution, weeks, status, current_round, round_start, member_count, round_deadline, grace_deadline = g
    meta = _token_meta(token)
    return {
        "id": int(group_id),
        "token": token,
        "token_symbol": meta["symbol"],
        "decimals": meta["decimals"],
        "contribution_amount": str(contribution),
        "contribution_amount_h": _raw_to_human(contribution, meta["decimals"]),
        "weeks": int(weeks),
        "status": GROUP_STATUS.get(int(status), "none"),
        "current_round": int(current_round),
        "round_start_at": int(round_start),
        "member_count": int(member_count),
        "round_deadline": int(round_deadline),
        "grace_deadline": int(grace_deadline),
        "pool_amount": str(int(contribution) * MEMBERS),
        "pool_amount_h": _raw_to_human(int(contribution) * MEMBERS, meta["decimals"]),
    }


def get_members(group_id):
    contract = get_contract()
    raw = contract.functions.getMembers(int(group_id)).call()
    return [str(m) for m in raw if str(m) != "0x0000000000000000000000000000000000000000"]


def get_payout_order(group_id):
    contract = get_contract()
    return [int(x) for x in contract.functions.getPayoutOrder(int(group_id)).call()]


def get_group_overview(group_id, wallet=None):
    """Group state + membership + the current round's payout/contribution view."""
    contract = get_contract()
    group = get_group(group_id)
    members = get_members(group_id)
    order = get_payout_order(group_id)
    group["members"] = members
    group["payout_order"] = order

    current_round = group["current_round"]
    if current_round >= 1:
        collected = contract.functions.roundCollected(int(group_id), current_round).call()
        recipient = contract.functions.recipientOf(int(group_id), current_round).call()
        group["current_round_collected"] = str(collected)
        group["current_round_collected_h"] = _raw_to_human(collected, group["decimals"])
        group["current_round_recipient"] = recipient
        group["current_round_pool_complete"] = bool(
            contract.functions.isPoolComplete(int(group_id), current_round).call()
        )
        paid_map = {}
        for m in members:
            paid_map[m.lower()] = bool(
                contract.functions.paid(int(group_id), current_round, m).call()
            )
        group["current_round_paid"] = paid_map

    if wallet:
        lw = str(wallet).lower()
        group["is_member"] = any(m.lower() == lw for m in members)
        if group["is_member"]:
            group["my_missed_rounds"] = int(contract.functions.missedRounds(int(group_id), wallet).call())
            group["my_consecutive_misses"] = int(contract.functions.consecutiveMisses(int(group_id), wallet).call())
            group["my_defaulted"] = bool(contract.functions.isDefaulted(int(group_id), wallet).call())
    return group


def get_my_groups(wallet):
    """Find every group the wallet is a member of, from MemberJoined events."""
    if not wallet or not is_configured():
        return []
    contract = get_contract()
    w3 = get_w3()
    latest = w3.eth.block_number
    logs = _chunked_logs(
        contract, "MemberJoined", _from_block(), latest,
        {"member": Web3.to_checksum_address(wallet)},
    )
    group_ids = sorted({int(log["args"]["groupId"]) for log in logs})
    out = []
    for gid in group_ids:
        try:
            out.append(get_group_overview(gid, wallet))
        except Exception as e:
            logger.warning("paluwagan: failed to load group %s: %s", gid, e)
    return out


def get_contributions(group_id):
    """All contribution events for a group (for the history tab)."""
    if not is_configured():
        return []
    contract = get_contract()
    w3 = get_w3()
    latest = w3.eth.block_number
    from_block = _from_block()
    made = _chunked_logs(contract, "ContributionMade", from_block, latest, {"groupId": int(group_id)})
    covered = _chunked_logs(contract, "ContributionCovered", from_block, latest, {"groupId": int(group_id)})

    rows = []
    for log in made:
        rows.append({
            "type": "contribution",
            "round": int(log["args"]["round"]),
            "member": log["args"]["member"],
            "amount": str(log["args"]["amount"]),
            "block": log["blockNumber"],
            "tx_hash": _tx_hash_hex(log),
        })
    for log in covered:
        rows.append({
            "type": "covered",
            "round": int(log["args"]["round"]),
            "member": log["args"]["member"],
            "payer": log["args"]["payer"],
            "amount": str(log["args"]["amount"]),
            "block": log["blockNumber"],
            "tx_hash": _tx_hash_hex(log),
        })
    rows.sort(key=lambda r: (int(r["block"]), r["tx_hash"]))
    return rows


def get_payout_history(group_id):
    """All PayoutClaimed events for a group."""
    if not is_configured():
        return []
    contract = get_contract()
    w3 = get_w3()
    latest = w3.eth.block_number
    logs = _chunked_logs(contract, "PayoutClaimed", _from_block(), latest, {"groupId": int(group_id)})
    rows = []
    for log in logs:
        rows.append({
            "round": int(log["args"]["round"]),
            "recipient": log["args"]["recipient"],
            "amount": str(log["args"]["amount"]),
            "block": log["blockNumber"],
            "tx_hash": _tx_hash_hex(log),
        })
    rows.sort(key=lambda r: int(r["block"]))
    return rows


def get_token_balance(wallet, token_address=None):
    """Read the connected wallet's balance of the group token (G$ in v1)."""
    if not wallet:
        return 0
    w3 = get_w3()
    token = token_address or GD_TOKEN_ADDRESS
    try:
        erc20 = w3.eth.contract(address=Web3.to_checksum_address(token), abi=ERC20_ABI)
        return int(erc20.functions.balanceOf(Web3.to_checksum_address(wallet)).call())
    except Exception as e:
        logger.warning("paluwagan: balance read failed: %s", e)
        return 0


def get_native_balance(wallet):
    """CELO balance — used to warn about gas before a contribution."""
    if not wallet:
        return 0
    try:
        return int(get_w3().eth.get_balance(Web3.to_checksum_address(wallet)))
    except Exception as e:
        logger.warning("paluwagan: native balance read failed: %s", e)
        return 0
