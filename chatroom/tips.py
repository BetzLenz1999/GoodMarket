"""Community Chatroom — user-to-user tipping.

A tip is a REAL on-chain transfer signed by the SENDER's own wallet (the app
never holds a key and never takes custody). The backend's only job is to:

  1. turn an ``@username`` into the recipient's wallet address,
  2. return unsigned transfer calldata for the sender to sign, and
  3. VERIFY the resulting tx (from / to / amount / token) before recording it
     and posting the public "Congrats …" room message.

Design notes (mirroring the rest of this codebase):
- Wallet addresses are the ownership keys only — they are never returned to the
  browser. The public message shows usernames.
- ``tx_hash`` is UNIQUE in ``community_chat_tips``, so replaying a confirm can
  never record (or announce) the same tip twice.
- The tx hash is the ONLY evidence accepted. A client claiming success is not
  enough.
- Reads go through the service-role client first so RLS cannot hide rows.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

logger = logging.getLogger(__name__)

ROOM = "general"
FEATURE_NAME = "chatroom_feature"

TIP_RATE_LIMIT_SECONDS = int(os.getenv("CHATROOM_TIP_RATE_LIMIT_SECONDS", "10"))
MAX_TIP_AMOUNT = Decimal(os.getenv("CHATROOM_MAX_TIP_AMOUNT", "1000000"))

CELO_CHAIN_ID = 42220
XDC_CHAIN_ID = 50
TOKEN_DECIMALS = 18

# keccak256("Transfer(address,address,uint256)") — decoded manually from the
# receipt logs so verification never depends on a contract-event ABI existing.
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
# keccak256("transfer(address,uint256)")[:4] — standard ERC-20 transfer.
TRANSFER_SELECTOR = "a9059cbb"

# ── Token registry ───────────────────────────────────────────────────────────
# Only tokens the app already supports elsewhere are offered. Addresses are
# env-overridable so a redeploy does not need a code change.
TOKENS = {
    "GD": {
        "label": "G$",
        "network": "celo",
        "chain_id": CELO_CHAIN_ID,
        "decimals": TOKEN_DECIMALS,
        "native": False,
        "address": os.getenv("CELO_GD_TOKEN_CONTRACT", "0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A"),
        "explorer": "https://celoscan.io/tx/",
        "rpc": os.getenv("CELO_RPC_URL", "https://forno.celo.org"),
    },
    "CELO": {
        "label": "CELO",
        "network": "celo",
        "chain_id": CELO_CHAIN_ID,
        "decimals": TOKEN_DECIMALS,
        "native": True,
        "address": "",
        "explorer": "https://celoscan.io/tx/",
        "rpc": os.getenv("CELO_RPC_URL", "https://forno.celo.org"),
    },
    "XDC_GD": {
        "label": "XDC G$",
        "network": "xdc",
        "chain_id": XDC_CHAIN_ID,
        "decimals": TOKEN_DECIMALS,
        "native": False,
        "address": os.getenv("XDC_GD_TOKEN_CONTRACT", "0xEC2136843a983885AebF2feB3931F73A8eBEe50c"),
        "explorer": "https://xdcscan.io/tx/",
        "rpc": os.getenv("XDC_RPC_URL", "https://earpc.xinfin.network"),
    },
    "XDC": {
        "label": "XDC",
        "network": "xdc",
        "chain_id": XDC_CHAIN_ID,
        "decimals": TOKEN_DECIMALS,
        "native": True,
        "address": "",
        "explorer": "https://xdcscan.io/tx/",
        "rpc": os.getenv("XDC_RPC_URL", "https://earpc.xinfin.network"),
    },
}

# Common aliases so "g$", "gd", "celo", "xdcg" all resolve.
_ALIASES = {
    "GD": "GD", "G$": "GD", "GOODDOLLAR": "GD", "GOODDOLLARS": "GD",
    "CELO": "CELO",
    "XDcgd": "XDC_GD", "XDCGD": "XDC_GD", "XDC_GD": "XDC_GD", "XDCG$": "XDC_GD",
    "XDC": "XDC",
}

_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,24}$")


def _get_supabase():
    """Service-role client first (RLS-safe reads), falling back to anon."""
    try:
        from supabase_client import get_supabase_admin_client, get_supabase_client

        return get_supabase_admin_client() or get_supabase_client()
    except Exception as exc:  # noqa: BLE001
        logger.error("chatroom tips: supabase client unavailable: %s", exc)
        return None


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Token helpers ────────────────────────────────────────────────────────────

def normalize_token(raw) -> str | None:
    """Map user input / aliases onto a registry key, or None when unsupported."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    if text in TOKENS:
        return text
    return _ALIASES.get(text.upper()) or _ALIASES.get(text)


def list_tip_tokens() -> list[dict]:
    """Public token list for the tip UI — labels/networks only, no secrets."""
    return [
        {"key": key, "label": meta["label"], "network": meta["network"],
         "chain_id": meta["chain_id"], "decimals": meta["decimals"]}
        for key, meta in TOKENS.items()
    ]


def parse_amount(raw) -> Decimal | None:
    """Positive decimal amount, or None when malformed / out of range."""
    if raw is None:
        return None
    try:
        amount = Decimal(str(raw).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return None
    if amount <= 0 or amount > MAX_TIP_AMOUNT:
        return None
    return amount


def to_wei(amount: Decimal, decimals: int = TOKEN_DECIMALS) -> int:
    return int((amount * (Decimal(10) ** decimals)).to_integral_value(rounding=ROUND_HALF_UP))


# ── ABI encoding (dependency-free) ───────────────────────────────────────────
# The tip flow must be preparable without web3/eth_abi installed (content tests
# run in a bare env), so transfer() calldata is built by hand — the layout is
# fixed: 4-byte selector, then two 32-byte words.

def _encode_transfer(to_address: str, amount_wei: int) -> str:
    addr = to_address.lower()
    if addr.startswith("0x"):
        addr = addr[2:]
    if len(addr) != 40:
        raise ValueError("Invalid recipient address")
    return "0x" + TRANSFER_SELECTOR + addr.rjust(64, "0") + format(amount_wei, "x").rjust(64, "0")


# ── Identity ─────────────────────────────────────────────────────────────────

def find_wallet_by_username(username: str) -> str | None:
    """Resolve an @username to its wallet address (case-insensitive).

    Usernames are unique (enforced when they are set), so this cannot pick the
    wrong account. Returns None when the name does not exist.
    """
    name = (username or "").strip().lstrip("@")
    if not name or not _USERNAME_RE.match(name):
        return None
    supabase = _get_supabase()
    if not supabase:
        return None
    try:
        result = (
            supabase.table("user_data")
            .select("wallet_address, username")
            .ilike("username", name)
            .limit(1)
            .execute()
        )
        if result and result.data:
            wallet = (result.data[0].get("wallet_address") or "").strip()
            return wallet or None
    except Exception as exc:  # noqa: BLE001
        logger.warning("chatroom tips: username lookup failed: %s", exc)
    return None


def username_for_wallet(wallet: str | None) -> str | None:
    from . import service as svc

    return svc.get_username(wallet)


def _public_name(wallet: str | None) -> str:
    from . import service as svc

    return svc.display_name(wallet)


# ── Public message copy ──────────────────────────────────────────────────────

def build_tip_message(recipient_name: str, sender_name: str, token_label: str, amount) -> str:
    """The public "Congrats …" line posted to the room for every successful tip.

    Deliberately reads like the community announcement users asked for:
    "🎉 Congrats @bob! You received 5 G$ from @alice 🎁".
    """
    return (
        f"🎉 Congrats @{recipient_name}! You received {_fmt_amount(amount)} "
        f"{token_label} from @{sender_name} 🎁"
    )


def _fmt_amount(amount) -> str:
    try:
        dec = Decimal(str(amount))
    except (InvalidOperation, ValueError):
        return str(amount)
    text = format(dec.normalize(), "f")
    return text


# ── Rate limiting ────────────────────────────────────────────────────────────

def _seconds_until_allowed(sender_wallet: str) -> int:
    supabase = _get_supabase()
    if not supabase:
        return 0
    try:
        result = (
            supabase.table("community_chat_tips")
            .select("created_at")
            .ilike("sender_wallet", sender_wallet)
            .order("id", desc=True)
            .limit(1)
            .execute()
        )
        if not result or not result.data:
            return 0
        from . import service as svc

        last = svc._parse_dt(result.data[0].get("created_at"))
        if not last:
            return 0
        elapsed = (_now() - last).total_seconds()
        if elapsed >= TIP_RATE_LIMIT_SECONDS:
            return 0
        return max(1, int(TIP_RATE_LIMIT_SECONDS - elapsed))
    except Exception as exc:  # noqa: BLE001
        logger.warning("chatroom tips: rate-limit lookup failed: %s", exc)
        return 0


# ── Prepare ──────────────────────────────────────────────────────────────────

def prepare_tip(sender_wallet: str, username: str, token: str, amount) -> dict:
    """Resolve the recipient and return unsigned transfer params for signing.

    Nothing here is trusted later — the confirm step re-verifies the tx on-chain.
    """
    from . import service as svc

    if not svc.is_enabled():
        return {"success": False, "error": "The chatroom is not available yet.", "code": "disabled"}

    token_key = normalize_token(token)
    if not token_key:
        return {"success": False, "error": "Unsupported token for tipping.", "code": "token"}

    parsed_amount = parse_amount(amount)
    if parsed_amount is None:
        return {"success": False, "error": "Enter a valid tip amount.", "code": "amount"}

    if svc.is_banned(sender_wallet):
        return {"success": False, "error": "You cannot tip in the chatroom.", "code": "banned"}

    recipient = find_wallet_by_username(username)
    if not recipient:
        return {
            "success": False,
            "error": f"@{str(username or '').strip().lstrip('@')} was not found in GoodMarket.",
            "code": "recipient",
        }

    if recipient.lower() == (sender_wallet or "").lower():
        return {"success": False, "error": "You cannot tip yourself.", "code": "self"}

    meta = TOKENS[token_key]
    amount_wei = to_wei(parsed_amount, meta["decimals"])

    if meta["native"]:
        to_address = recipient
        data = "0x"
        value = hex(amount_wei)
    else:
        to_address = meta["address"]
        data = _encode_transfer(recipient, amount_wei)
        value = "0x0"

    return {
        "success": True,
        "token": token_key,
        "token_label": meta["label"],
        "network": meta["network"],
        "chain_id": meta["chain_id"],
        "explorer": meta["explorer"],
        "amount": _fmt_amount(parsed_amount),
        "recipient_username": (username or "").strip().lstrip("@"),
        # The address is returned ONLY to the sender's own browser so their
        # wallet can sign the transfer; it is never echoed into the room.
        "to": to_address,
        "data": data,
        "value": value,
    }


# ── On-chain verification ────────────────────────────────────────────────────

def _normalize_hex(value) -> str:
    h = value.hex() if hasattr(value, "hex") else str(value)
    return h if h.startswith("0x") else "0x" + h


def _get_w3(meta: dict):
    from web3 import Web3

    return Web3(Web3.HTTPProvider(meta["rpc"], request_kwargs={"timeout": 12}))


def _decode_token_transfers(receipt, token_address: str) -> list[dict]:
    """ABI-free Transfer log decoding, filtered to the tip token contract."""
    transfers = []
    for log in receipt.get("logs") or []:
        try:
            if (log.get("address") or "").lower() != token_address.lower():
                continue
            topics = log.get("topics") or []
            if len(topics) < 3:
                continue
            if _normalize_hex(topics[0]).lower() != TRANSFER_TOPIC:
                continue
            data = log.get("data")
            transfers.append({
                "from": "0x" + _normalize_hex(topics[1])[-40:],
                "to": "0x" + _normalize_hex(topics[2])[-40:],
                "value": int(_normalize_hex(data), 16) if data else 0,
            })
        except Exception as exc:  # noqa: BLE001
            logger.warning("chatroom tips: skipping undecodable log: %s", exc)
    return transfers


def verify_tip_tx(tx_hash: str, token_key: str, sender_wallet: str,
                  recipient_wallet: str, amount) -> dict:
    """Verify a claimed tip transfer on-chain.

    Returns ``{ok, error, received}`` where ``received`` is the amount actually
    transferred to the recipient (present whenever funds demonstrably moved,
    even if something else mismatched).
    """
    meta = TOKENS.get(token_key)
    if not meta:
        return {"ok": False, "error": "Unsupported token.", "received": None}

    expected_wei = to_wei(parse_amount(amount) or Decimal(0), meta["decimals"])
    if expected_wei <= 0:
        return {"ok": False, "error": "Invalid amount.", "received": None}

    try:
        w3 = _get_w3(meta)
        receipt = w3.eth.get_transaction_receipt(tx_hash)
    except Exception as exc:  # noqa: BLE001
        logger.warning("chatroom tips: receipt lookup failed for %s: %s", tx_hash, exc)
        return {"ok": False, "error": "Transaction is still confirming on-chain. Please try again in a minute.", "received": None}

    if receipt is None:
        return {"ok": False, "error": "Transaction is still confirming on-chain. Please try again in a minute.", "received": None}
    if receipt.get("status") != 1:
        return {"ok": False, "error": "Transaction failed on-chain.", "received": None}

    sender = (sender_wallet or "").lower()
    recipient = (recipient_wallet or "").lower()

    if meta["native"]:
        try:
            tx = w3.eth.get_transaction(tx_hash)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": "Could not read the transaction.", "received": None}
        frm = (tx.get("from") or "").lower()
        to = (tx.get("to") or "").lower()
        value = int(tx.get("value") or 0)
        if frm != sender:
            return {"ok": False, "error": "This transfer was not sent from your wallet.", "received": None}
        if to != recipient:
            return {"ok": False, "error": "This transfer was not sent to that user.", "received": None}
        received = Decimal(value) / (Decimal(10) ** meta["decimals"])
        if value != expected_wei:
            return {"ok": False, "error": f"Amount mismatch: expected {_fmt_amount(amount)} but sent {_fmt_amount(received)}.", "received": received}
        return {"ok": True, "error": None, "received": received}

    transfers = _decode_token_transfers(receipt, meta["address"])
    received_wei = sum(
        t["value"] for t in transfers
        if t["from"].lower() == sender and t["to"].lower() == recipient
    )
    if not received_wei:
        return {"ok": False, "error": "No matching token transfer from your wallet to that user was found in this transaction.", "received": None}

    received = Decimal(received_wei) / (Decimal(10) ** meta["decimals"])
    if received_wei != expected_wei:
        return {"ok": False, "error": f"Amount mismatch: expected {_fmt_amount(amount)} but sent {_fmt_amount(received)}.", "received": received}
    return {"ok": True, "error": None, "received": received}


# ── Record ───────────────────────────────────────────────────────────────────

def _tip_message_insert(supabase, sender_wallet: str, text: str, token_key: str,
                        amount_text: str, tx_hash: str) -> dict | None:
    """Insert the public tip message directly.

    Deliberately NOT routed through ``service.post_message``: the money has
    already moved on-chain by this point, so a chat cooldown must never be able
    to drop the record/announcement. Bans are enforced earlier.
    """
    from . import service as svc

    try:
        result = (
            supabase.table("community_chat_messages")
            .insert({
                "room": ROOM,
                "wallet_address": sender_wallet,
                "username": svc.get_username(sender_wallet),
                "message": text,
                "message_type": "tip",
                "tip_token": token_key,
                "tip_amount": amount_text,
                "tip_tx_hash": tx_hash,
            })
            .execute()
        )
        if result and result.data:
            return result.data[0]
    except Exception as exc:  # noqa: BLE001
        # The tip row itself is the source of truth; a missing announcement is
        # not worth failing the whole call over.
        logger.error("chatroom tips: tip message insert failed: %s", exc)
    return None


def record_tip(sender_wallet: str, username: str, token: str, amount, tx_hash: str) -> dict:
    """Verify and persist a tip, then announce it in the room.

    Idempotent: the UNIQUE ``tx_hash`` means a replayed confirm returns the
    already-recorded tip instead of announcing it twice.
    """
    from . import service as svc

    if not svc.is_enabled():
        return {"success": False, "error": "The chatroom is not available yet.", "code": "disabled"}
    if not tx_hash or not str(tx_hash).startswith("0x"):
        return {"success": False, "error": "A transaction hash is required.", "code": "tx_hash"}

    token_key = normalize_token(token)
    if not token_key:
        return {"success": False, "error": "Unsupported token for tipping.", "code": "token"}

    parsed_amount = parse_amount(amount)
    if parsed_amount is None:
        return {"success": False, "error": "Enter a valid tip amount.", "code": "amount"}

    if svc.is_banned(sender_wallet):
        return {"success": False, "error": "You cannot tip in the chatroom.", "code": "banned"}

    recipient = find_wallet_by_username(username)
    if not recipient:
        return {"success": False, "error": "That user was not found in GoodMarket.", "code": "recipient"}
    if recipient.lower() == (sender_wallet or "").lower():
        return {"success": False, "error": "You cannot tip yourself.", "code": "self"}

    supabase = _get_supabase()
    if not supabase:
        return {"success": False, "error": "Database unavailable", "code": "db"}

    # Idempotency first — never re-verify (or re-announce) a hash we already
    # recorded, and never let a replay consume the rate-limit budget.
    existing = _find_tip_by_hash(supabase, tx_hash)
    if existing:
        return {
            "success": True,
            "duplicate": True,
            "tip": _public_tip(existing, recipient, sender_wallet),
        }

    wait = _seconds_until_allowed(sender_wallet)
    if wait > 0:
        return {"success": False, "error": f"Please wait {wait}s before tipping again.",
                "code": "rate_limited", "retry_after": wait}

    verification = verify_tip_tx(tx_hash, token_key, sender_wallet, recipient, parsed_amount)
    if not verification.get("ok"):
        return {"success": False, "error": verification.get("error") or "Could not verify the tip.", "code": "verify"}

    meta = TOKENS[token_key]
    sender_name = _public_name(sender_wallet)
    recipient_name = _public_name(recipient)
    amount_text = _fmt_amount(parsed_amount)
    congrats = build_tip_message(recipient_name, sender_name, meta["label"], amount_text)

    try:
        result = (
            supabase.table("community_chat_tips")
            .insert({
                "room": ROOM,
                "sender_wallet": sender_wallet,
                "sender_username": sender_name,
                "recipient_wallet": recipient,
                "recipient_username": recipient_name,
                "token": token_key,
                "amount": amount_text,
                "network": meta["network"],
                "tx_hash": tx_hash,
            })
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        # A concurrent confirm of the same hash hits the UNIQUE constraint —
        # treat it as the idempotent success it is.
        existing = _find_tip_by_hash(supabase, tx_hash)
        if existing:
            return {"success": True, "duplicate": True, "tip": _public_tip(existing, recipient, sender_wallet)}
        logger.error("chatroom tips: insert failed: %s", exc)
        return {"success": False, "error": "Failed to record the tip.", "code": "insert"}

    tip_row = (result.data or [{}])[0] if result else {}

    message_row = _tip_message_insert(supabase, sender_wallet, congrats, token_key, amount_text, tx_hash)
    message_id = (message_row or {}).get("id")
    if message_id and tip_row.get("id"):
        try:
            supabase.table("community_chat_tips").update({"message_id": message_id}).eq("id", tip_row["id"]).execute()
        except Exception as exc:  # noqa: BLE001
            logger.warning("chatroom tips: linking message failed: %s", exc)

    return {
        "success": True,
        "duplicate": False,
        "message": svc._public_row(message_row, sender_wallet) if message_row else None,
        "tip": {
            "token": token_key,
            "token_label": meta["label"],
            "amount": amount_text,
            "network": meta["network"],
            "tx_hash": tx_hash,
            "explorer_url": meta["explorer"] + tx_hash,
            "recipient_username": recipient_name,
            "sender_username": sender_name,
            "is_me": True,
        },
    }


def _find_tip_by_hash(supabase, tx_hash: str) -> dict | None:
    try:
        result = (
            supabase.table("community_chat_tips")
            .select("id, sender_wallet, sender_username, recipient_wallet, recipient_username, token, amount, network, tx_hash, created_at")
            .eq("tx_hash", tx_hash)
            .limit(1)
            .execute()
        )
        if result and result.data:
            return result.data[0]
    except Exception as exc:  # noqa: BLE001
        logger.warning("chatroom tips: tx lookup failed: %s", exc)
    return None


def _public_tip(row: dict, recipient_wallet: str, viewer_wallet: str | None) -> dict:
    meta = TOKENS.get(row.get("token") or "", {})
    tx_hash = row.get("tx_hash") or ""
    return {
        "token": row.get("token"),
        "token_label": meta.get("label", row.get("token")),
        "amount": row.get("amount"),
        "network": row.get("network") or meta.get("network"),
        "tx_hash": tx_hash,
        "explorer_url": (meta.get("explorer", "") + tx_hash) if tx_hash else "",
        "recipient_username": row.get("recipient_username") or _public_name(recipient_wallet),
        "sender_username": row.get("sender_username"),
        "is_me": bool(viewer_wallet) and (row.get("sender_wallet") or "").lower() == viewer_wallet.lower(),
    }
