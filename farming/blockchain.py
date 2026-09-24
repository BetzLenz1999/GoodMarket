"""GoodMarket Chicken Farm — per-wallet on-chain history.

Farm actions are signed by the user's own wallet, so the backend never sees a
record and the browser-local history in ``static/js/farming-history.js`` is the
only trace. That made two things impossible:

  * The history was keyed globally per BROWSER, not per WALLET, so two accounts
    on one device shared (and clobbered) each other's rows.
  * Clearing site data / switching device / private mode silently erased the
    record — even though the farm contract still holds every event forever.

The contract is the durable source of truth: ``FarmStarted``, ``EggsSold`` and
``FarmClosed`` are emitted for the acting wallet and are queryable by indexed
address. This module reconstructs a wallet's complete farm history from those
events, so "old transactions never disappear".

Design notes:
  * Reads go through the shared ``blockchain`` helpers (``_get_logs_full``), so
    chunking under forno's 5000-block ``eth_getLogs`` cap, adaptive range
    halving and RPC failover are all inherited, not re-implemented.
  * Only the wallet's own events are ever returned — the log filter is anchored
    on the indexed user topic, so one wallet can never receive another's rows.
  * The scan is anchored to the contract's deploy block (discovered once via an
    ``eth_getCode`` binary search, or set explicitly with
    ``FARMING_DEPLOY_BLOCK``) instead of scanning from genesis.
  * Event data is decoded by slicing topics/data words directly, so no ABI
    dependency is needed and the decoder is unit-testable.
"""

from __future__ import annotations

import logging
import os
import threading
import time

try:  # imported lazily-safe so the module loads without the project deps
    from blockchain import (
        _calculate_block_range,
        _celo_rpc_urls,
        _format_timestamps_batch,
        _get_logs_full,
        _get_latest_block_number,
        _get_rpc_session,
        _topic_for_address,
    )
except Exception:  # pragma: no cover - only when blockchain itself is unimportable
    _get_logs_full = None  # type: ignore
    _topic_for_address = None  # type: ignore
    _format_timestamps_batch = None  # type: ignore
    _celo_rpc_urls = None  # type: ignore
    _get_latest_block_number = None  # type: ignore
    _get_rpc_session = None  # type: ignore
    _calculate_block_range = None  # type: ignore

logger = logging.getLogger("farming.blockchain")

# keccak256 event signatures — verified against ethers 6.13.4 `id()`.
FARM_STARTED_TOPIC = "0x7149cad02ed72d4294d82633c1daeb9025185ce693f5988f3933a931a17cbda2"
EGGS_SOLD_TOPIC = "0x7d94857182d09fe7f9623ce127cc27fd1be3b70c926edf4e7324f9e4e7cfce14"
FARM_CLOSED_TOPIC = "0xbe40ce4ce3eec04f7b492e9df5b191110e2860b5a423176001e015f94786f78a"

USER_EVENT_TOPICS = (FARM_STARTED_TOPIC, EGGS_SOLD_TOPIC, FARM_CLOSED_TOPIC)

EVENT_ACTION = {
    FARM_STARTED_TOPIC: "startFarm",
    EGGS_SOLD_TOPIC: "sellEggs",
    FARM_CLOSED_TOPIC: "closeFarm",
}
EVENT_LABEL = {
    FARM_STARTED_TOPIC: "Start farm",
    EGGS_SOLD_TOPIC: "Sell eggs",
    FARM_CLOSED_TOPIC: "Close farm",
}

WEI_PER_GD = 10 ** 18

# A farm matures 30 days after start; a lookback of that many days always covers
# at least the current cycle, so a wallet with an active farm is fully visible
# even when the deploy block is unknown.
DEFAULT_LOOKBACK_DAYS = 45

# Deploy-block discovery / result caching.
_deploy_block_lock = threading.Lock()
_deploy_block_cache: dict = {}          # contract_lower -> block int
_history_cache_lock = threading.Lock()
_history_cache: dict = {}               # (contract_lower, wallet_lower) -> {expires_at, rows}
HISTORY_CACHE_TTL = 60


def get_deploy_block(contract_address: str, latest_block: int | None = None,
                     session=None) -> int:
    """Return the block the farm contract was deployed at.

    Prefers the ``FARMING_DEPLOY_BLOCK`` env var (an explicit, cheap
    configuration), else binary-searches ``eth_getCode`` for the first block
    that returns non-empty bytecode. That state is available on Celo archive
    nodes (verified on forno.celo.org), so no indexing service is required.

    Returns 0 when discovery fails, which makes the caller scan the bounded
    lookback window instead of the whole chain — slower but never wrong.
    """
    env_override = os.getenv("FARMING_DEPLOY_BLOCK", "").strip()
    if env_override:
        try:
            return max(0, int(env_override))
        except (TypeError, ValueError):
            logger.warning("Invalid FARMING_DEPLOY_BLOCK=%r; ignoring", env_override)

    contract = (contract_address or "").lower()
    if not contract:
        return 0
    with _deploy_block_lock:
        cached = _deploy_block_cache.get(contract)
        if cached is not None:
            return cached

    if session is None:
        try:
            session = _get_rpc_session()
        except Exception:
            session = None
    if session is None or _get_latest_block_number is None:
        return 0

    try:
        head = latest_block if latest_block is not None else _get_latest_block_number()
    except Exception:
        return 0
    if not head:
        return 0

    def _has_code(block: int) -> bool:
        payload = {
            "jsonrpc": "2.0",
            "method": "eth_getCode",
            "params": [contract_address, hex(block)],
            "id": 1,
        }
        for url in (_celo_rpc_urls() if _celo_rpc_urls else []):
            try:
                resp = session.post(url, json=payload, timeout=12)
                data = resp.json()
            except Exception:
                continue
            code = data.get("result") if isinstance(data, dict) else None
            if isinstance(code, str) and len(code) > 2:
                return True
            if isinstance(code, str) and code == "0x":
                return False
        # All RPCs failed — treat as absent so the search converges downward.
        return False

    if not _has_code(head):
        return 0

    low, high = 0, head
    # Only evaluated at midpoints, so ~log2(head) ≈ 27 calls worst case.
    while low < high:
        mid = (low + high) // 2
        if _has_code(mid):
            high = mid
        else:
            low = mid + 1
    found = low
    with _deploy_block_lock:
        _deploy_block_cache[contract] = found
    logger.info("🐔 Farm contract deploy block discovered: %s", found)
    return found


def _word_to_int(word_hex) -> int:
    """Parse an ABI data word (or a hex quantity) as an int, never raising."""
    if word_hex is None:
        return 0
    if isinstance(word_hex, int):
        return word_hex
    text = str(word_hex).strip()
    if not text:
        return 0
    try:
        return int(text, 16)
    except (TypeError, ValueError):
        return 0


def decode_farm_event(log: dict) -> dict | None:
    """Decode one farm log into a history row without an ABI.

    AbiEncoderV2-free event shapes (all fields are static words):
      FarmStarted(address indexed user, uint256 principal, uint256 chickens,
                  uint256 startedAt, uint256 unlocksAt)
        topics = [sig, user]; data = [principal, chickens, startedAt, unlocksAt]
      EggsSold(address indexed user, uint256 eggs, uint256 profitGd,
               uint256 timestamp)
        topics = [sig, user]; data = [eggs, profitGd, timestamp]
      FarmClosed(address indexed user, uint256 principal,
                 uint256 finalEggProfitGd, uint256 totalPaidGd, uint256 timestamp)
        topics = [sig, user]; data = [principal, finalEggProfitGd, totalPaidGd, timestamp]
    """
    if not isinstance(log, dict):
        return None
    topics = log.get("topics") or []
    if not topics:
        return None
    topic0 = (topics[0] or "").lower()
    action = EVENT_ACTION.get(topic0)
    if not action:
        return None

    data = (log.get("data") or "").lower()
    if data.startswith("0x"):
        data = data[2:]
    words = [data[i:i + 64] for i in range(0, len(data), 64)]
    # Pad so short/truncated payloads yield 0 instead of IndexError.
    while len(words) < 4:
        words.append("0" * 64)

    principal = _word_to_int(words[0])
    chickens = _word_to_int(words[1])

    amount_wei = 0
    amount_label = ""
    note = ""
    if action == "startFarm":
        amount_wei = principal
        amount_label = "%s G$" % _format_gd(principal)
        note = "%s chickens" % chickens
    elif action == "sellEggs":
        eggs = _word_to_int(words[0])
        profit = _word_to_int(words[1])
        amount_wei = profit
        amount_label = "%s G$" % _format_gd(profit)
        note = "%s eggs" % eggs
    elif action == "closeFarm":
        # words = [principal, finalEggProfitGd, totalPaidGd, timestamp];
        # the total already includes the final egg profit.
        total_paid = _word_to_int(words[2])
        amount_wei = total_paid
        amount_label = "%s G$" % _format_gd(total_paid)
        note = "Principal + egg rewards"

    block_number = _word_to_int(log.get("blockNumber"))
    log_index = _word_to_int(log.get("logIndex"))

    return {
        "hash": log.get("transactionHash") or "",
        "action": action,
        "actionLabel": EVENT_LABEL.get(topic0, action),
        "amountLabel": amount_label,
        "amountGdWei": str(amount_wei),
        "note": note,
        "blockNumber": block_number,
        "logIndex": log_index,
        "wallet": (log.get("_wallet") or ""),
        "source": "onchain",
    }


def _format_gd(wei: int) -> str:
    """Exact wei -> G$ display (max 4 decimals, thousands-separated).

    Mirrors the browser's ``formatWei`` so an on-chain row and a locally
    tracked row render identically.
    """
    try:
        wei = int(wei)
    except (TypeError, ValueError):
        return "0"
    neg = wei < 0
    if neg:
        wei = -wei
    whole = wei // WEI_PER_GD
    frac = wei % WEI_PER_GD
    frac_str = str(frac).rjust(18, "0").rstrip("0")[:4]
    out = "{:,}".format(whole)
    if frac_str:
        out += "." + frac_str
    return ("-" if neg else "") + out


def fetch_wallet_farm_history(contract_address: str, wallet_address: str,
                              latest_block: int | None = None,
                              session=None, force: bool = False) -> list:
    """Return the wallet's complete farm history from the contract, newest first.

    The filter pins topic1 to the wallet's address, so the result can only ever
    contain that wallet's events — never another user's.
    """
    contract = (contract_address or "").strip()
    wallet = (wallet_address or "").strip()
    if not contract or not wallet:
        return []
    if _get_logs_full is None:
        logger.error("farming history: blockchain helpers unavailable")
        return []

    cache_key = (contract.lower(), wallet.lower())
    if not force:
        with _history_cache_lock:
            entry = _history_cache.get(cache_key)
            if entry and entry["expires_at"] > time.time():
                return entry["rows"]

    if session is None:
        try:
            session = _get_rpc_session()
        except Exception:
            session = None

    try:
        head = latest_block if latest_block is not None else _get_latest_block_number()
    except Exception:
        head = 0
    if not head:
        return []

    deploy_block = get_deploy_block(contract, latest_block=head, session=session)
    if deploy_block > 0:
        from_block = deploy_block
    elif _calculate_block_range is not None:
        # Bounded fallback: no archive state for the anchor, so cover the
        # current max cycle instead of scanning from genesis.
        from_hex, _ = _calculate_block_range(DEFAULT_LOOKBACK_DAYS * 24)
        from_block = max(0, int(from_hex, 16))
    else:
        from_block = max(0, head - (DEFAULT_LOOKBACK_DAYS * 24 * 720))

    wallet_topic = (_topic_for_address(wallet) if _topic_for_address
                    else "0x" + ("0" * 24) + wallet.lower().replace("0x", ""))
    params = {
        "address": contract,
        # topic0 array = OR over the three user actions; topic1 = this wallet.
        "topics": [list(USER_EVENT_TOPICS), wallet_topic],
    }

    try:
        logs = _get_logs_full(params, from_block, head)
    except Exception as exc:
        logger.error("farming history scan failed for %s: %s", wallet[:10], exc)
        return []

    rows = []
    for log in logs:
        row = decode_farm_event(log)
        if not row:
            continue
        row["wallet"] = wallet
        rows.append(row)

    # Stable ordering: block then log index, newest first.
    rows.sort(key=lambda r: (r.get("blockNumber") or 0, r.get("logIndex") or 0), reverse=True)

    # Fill human timestamps in one batched round-trip instead of per-log calls.
    if rows and _format_timestamps_batch is not None:
        try:
            stamps = _format_timestamps_batch([r["blockNumber"] for r in rows if r.get("blockNumber")])
            for r in rows:
                r["timeLabel"] = stamps.get(r.get("blockNumber"), "")
        except Exception as exc:
            logger.warning("farming history timestamp batch failed: %s", exc)

    with _history_cache_lock:
        _history_cache[cache_key] = {"expires_at": time.time() + HISTORY_CACHE_TTL, "rows": rows}
    return rows


def invalidate_history_cache(wallet_address: str = "", contract_address: str = "") -> None:
    with _history_cache_lock:
        if not wallet_address and not contract_address:
            _history_cache.clear()
            return
        wallet = (wallet_address or "").lower()
        contract = (contract_address or "").lower()
        for key in list(_history_cache):
            if (not contract or key[0] == contract) and (not wallet or key[1] == wallet):
                _history_cache.pop(key, None)
