"""Daily Lotto (3 digits) — business logic.

Handles round/ticket/win/prize-tier/vault-alert logic on top of Supabase.

PCSO-style rules: the player picks THREE digits (each 0-9, in order) once per
Philippines game date. The 8PM draw publishes three digits in order.
- STRAIGHT: the pick matches the draw digit-for-digit, in the same order.
- RUMBLE:   the same three digits in any other order.

Straight and rumble are represented with the existing ``match_count`` column to
avoid a destructive migration: match_count 6 = straight, match_count 3 =
rumble. Both maps onto the ``daily_lotto_prize_tiers`` CHECK (3..6) range.

Design invariants (mirroring the rest of this codebase):
- The draw scheduler is the ONLY writer of winning numbers.
- The DB is the source of truth; the contract is used only as a pull-vault
  on-chain (grant/claim).
- Every state transition that must be single-winner is done with a CAS
  (compare-and-set via ``.eq('status', expected)`` in the UPDATE where-clause),
  so gunicorn workers / two scheduler ticks can never double-draw or
  double-grant.
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
import threading
import time
from datetime import date, datetime, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

MANILA_TZ = ZoneInfo("Asia/Manila")
DRAW_HOUR_PHT = int(os.getenv("DAILY_LOTTO_DRAW_HOUR_PHT", "20"))

MIN_NUMBER = 0
MAX_NUMBER = 9
PICK_SIZE = 3

# Straight (exact order) vs rumble (same digits, any order). Stored in the
# match_count slot: the tiers table only allows 3..6.
STRAIGHT_MATCH = 6
RUMBLE_MATCH = 3

WIN_STRAIGHT = "straight"
WIN_RUMBLE = "rumble"

ALERT_THROTTLE_SEC = float(os.getenv("DAILY_LOTTO_ALERT_THROTTLE_SEC", "3600"))


def _get_supabase():
    """Reads use the service-role (admin) client so row-level security can never
    hide a user's own rows (a saved pick / win that reads back as empty looks
    like the pick was never saved — the root cause of the "wala sa database"
    reports). Falls back to the anon client only when the admin client is
    unconfigured."""
    from supabase_client import get_supabase_admin_client, get_supabase_client
    return get_supabase_admin_client() or get_supabase_client()


def _get_supabase_admin():
    from supabase_client import get_supabase_admin_client
    return get_supabase_admin_client() or _get_supabase()


def _now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Time helpers (Philippines game date) ─────────────────────────────────────

def manila_now() -> datetime:
    return datetime.now(MANILA_TZ)


def current_round_metadata() -> dict:
    """Return the current PH game-date round's key values."""
    now = manila_now()
    game_date: date = now.date()
    round_id = int(game_date.strftime("%Y%m%d"))
    draw_dt = datetime(game_date.year, game_date.month, game_date.day, DRAW_HOUR_PHT, tzinfo=MANILA_TZ)
    drawn = now >= draw_dt
    return {
        "round_id": round_id,
        "game_date": game_date.isoformat(),
        "draw_time_pht": draw_dt.strftime("%Y-%m-%d %H:%M"),
        "drawn": drawn,
        "now_pht": now.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "seconds_to_draw": max(0.0, (draw_dt - now).total_seconds()),
    }


def date_to_round_id(d: date) -> int:
    return int(d.strftime("%Y%m%d"))


# ── Pick validation ───────────────────────────────────────────────────────────

def validate_pick(numbers) -> tuple:
    """Return (ok, error, normalized_list). Accepts list/tuple of 3 digits,
    each 0..9. ORDER MATTERS (straight vs rumble) and repeated digits are allowed
    ("112" is a valid PCSO-style pick)."""
    try:
        vals = [int(x) for x in numbers]
    except (TypeError, ValueError):
        return False, "Invalid digits.", None
    if len(vals) != PICK_SIZE:
        return False, f"Pick exactly {PICK_SIZE} digits.", None
    if any(v < MIN_NUMBER or v > MAX_NUMBER for v in vals):
        return False, f"Each digit must be between {MIN_NUMBER} and {MAX_NUMBER}.", None
    return True, None, vals


def _seed_hash(numbers, round_id, salt: str = "goodmarket-lotto") -> str:
    """Deterministic opaque hash of the drawn digits (for the DB badge)."""
    payload = f"{round_id}:{','.join(str(n) for n in numbers)}:{salt}"
    return "0x" + hashlib.sha256(payload.encode()).hexdigest()


# ── Pick-signature proof of wallet ownership ─────────────────────────────────

def build_pick_message(address: str, round_id, numbers: list) -> str:
    """The exact text a user signs (personal_sign / EIP-191) to prove they own
    the wallet before their pick is recorded. Binds the wallet + round + digits
    so a captured signature can't be replayed on another pick/day.

    Digits keep their PICKED ORDER (straight vs rumble depends on it), unlike
    the old 6/100 version which sorted."""
    nums = ",".join(str(int(x)) for x in numbers)
    return (
        "GoodMarket Daily Lotto — submit my pick\n"
        f"Wallet: {address}\n"
        f"Round: {round_id}\n"
        f"Numbers: {nums}\n"
        "I confirm I own this wallet."
    )


def _eip191_payloads(message: str, expected: str):
    """Return (label, encode_defunct_obj) candidates that may have been signed.

    The lotto page hex-encodes the UTF-8 message before personal_sign (Trust
    Wallet's mobile dApp hangs on plain-text payloads with newlines), but
    POSTs the readable ``message`` text. Wallets handle the payload they're
    shown differently:

    * MetaMask / spec: hex-decodes and signs the raw UTF-8 bytes
      (``encode_defunct(hexstr=...)``).
    * Some mobile wallets (Trust historically): sign the literal 0x-hex
      string as UTF-8 text (``encode_defunct(text=<the hex string>)``).
    * The in-app local wallet hex-decodes first and signs the readable text
      (``encode_defunct(text=...)``).

    ``expected`` is the canonical readable text. If ``message`` matches it we
    try the text form plus both hex interpretations of that same text. The
    signature still must ecrecover to the session wallet, so a wrong guess can
    never accept a forgery — it only finds the payload the user signed.
    """
    from eth_account.messages import encode_defunct

    stripped = (message or "").strip()
    if stripped == expected.strip():
        # The page POSTs the readable text. Its hex encoding (without the 0x
        # prefix) is what personal_sign received, so the wallet may have
        # signed any of: the text itself (local wallet), the raw UTF-8 bytes
        # of the hex (MetaMask/spec), or the literal 0x-hex string (Trust).
        hex_body = expected.encode("utf-8").hex()
        return [
            ("text", encode_defunct(text=stripped)),
            ("hex-bytes", encode_defunct(hexstr=hex_body)),
            ("hex-as-text", encode_defunct(text="0x" + hex_body)),
        ]

    # Defensive: if the caller POSTed the hex form directly, accept it too.
    hex_body_expected = expected.encode("utf-8").hex()
    if stripped in ("0x" + hex_body_expected, hex_body_expected):
        return [
            ("hex-bytes", encode_defunct(hexstr=hex_body_expected)),
            ("hex-as-text", encode_defunct(text=stripped)),
        ]

    logger.warning("❌ Lotto pick message mismatch — refusing signature")
    return []


def verify_pick_signature(
    message: str,
    signature: str,
    address: str,
    round_id,
    numbers: list,
) -> bool:
    """ecrecover the personal_sign payload and confirm it matches the session
    wallet. Same pattern as the app-wide local-wallet login verifier
    (encode_defunct + Account.recover_message)."""
    try:
        from eth_account import Account
        from eth_account.messages import encode_defunct
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ eth_account unavailable for pick verification: %s", exc)
        return False
    try:
        if not message or not signature:
            return False
        expected = build_pick_message(address, round_id, numbers)
        candidates = _eip191_payloads(message, expected)
        for label, msg_obj in candidates:
            try:
                recovered = Account.recover_message(msg_obj, signature=signature)
                if recovered.lower() == str(address).lower():
                    return True
            except Exception as exc:  # noqa: BLE001
                logger.warning("⚠️ Lotto pick %s candidate rejected: %s", label, exc)
        logger.warning("❌ Lotto pick signature did not match any payload form")
        return False
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ Lotto pick signature verify failed: %s", exc)
        return False


# ── Prize tiers ──────────────────────────────────────────────────────────────

_DEFAULT_TIERS = {RUMBLE_MATCH: Decimal("1000"), STRAIGHT_MATCH: Decimal("50000")}
_tier_cache: dict = {}
_tier_cache_at: float = 0.0
_TIER_CACHE_TTL = 30.0


def set_cache_tiers(tiers: dict) -> None:
    """Override for tests; also busts the TTL cache."""
    global _tier_cache, _tier_cache_at
    _tier_cache = {int(k): Decimal(str(v)) for k, v in tiers.items()}
    _tier_cache_at = time.time()


def get_prize_tiers(use_cache=True) -> dict:
    """Return {match_count: Decimal(amount_gd)} with a short TTL cache."""
    global _tier_cache, _tier_cache_at
    if use_cache and _tier_cache and time.time() - _tier_cache_at < _TIER_CACHE_TTL:
        return dict(_tier_cache)
    try:
        sb = _get_supabase()
        if sb is None:
            raise RuntimeError("db unavailable")
        res = sb.table("daily_lotto_prize_tiers").select("match_count, amount_gd").execute()
        tiers = {int(r["match_count"]): Decimal(str(r["amount_gd"])) for r in (res.data or [])}
        if not tiers:
            raise RuntimeError("empty tiers")
        _tier_cache = tiers
        _tier_cache_at = time.time()
        return dict(tiers)
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ Failed to read prize tiers (%s); using defaults", exc)
        return dict(_DEFAULT_TIERS)


def update_prize_tiers(updates: dict, admin_wallet: str) -> dict:
    """Admin upsert of one or more tier amounts. ``updates`` = {match_count: amount}.
    Only the two live tiers are accepted: 6 = straight, 3 = rumble."""
    try:
        sb = _get_supabase_admin()
        for match_count, amount in updates.items():
            match_count = int(match_count)
            if match_count not in (RUMBLE_MATCH, STRAIGHT_MATCH):
                return {"success": False, "error": "match_count must be 6 (straight) or 3 (rumble)"}
            amount = Decimal(str(amount))
            if amount < 0:
                return {"success": False, "error": "Amount cannot be negative"}
            sb.table("daily_lotto_prize_tiers").upsert({
                "match_count": match_count,
                "amount_gd": float(amount),
                "updated_by": admin_wallet,
                "updated_at": _now_utc_iso(),
            }, on_conflict="match_count").execute()
        set_cache_tiers({})
        return {"success": True, "tiers": {str(k): str(v) for k, v in get_prize_tiers(use_cache=False).items()}}
    except Exception as exc:  # noqa: BLE001
        logger.error("❌ Failed to update prize tiers: %s", exc)
        return {"success": False, "error": str(exc)}


# ── Settings ─────────────────────────────────────────────────────────────────

def _get_setting(key: str, default: str = "0") -> str:
    try:
        sb = _get_supabase()
        if sb is None:
            return default
        res = sb.table("daily_lotto_settings").select("value").eq("key", key).single().execute()
        if res.data and res.data.get("value") is not None:
            return str(res.data["value"])
        return default
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ Could not read setting %s: %s", key, exc)
        return default


def _set_setting(key: str, value: str, admin_wallet: str) -> None:
    sb = _get_supabase_admin()
    sb.table("daily_lotto_settings").upsert({
        "key": key,
        "value": str(value),
        "updated_by": admin_wallet,
        "updated_at": _now_utc_iso(),
    }, on_conflict="key").execute()


def get_daily_prize_pool_cap() -> Decimal:
    """0 = unlimited prize pool; otherwise a daily G$ cap that prorates tiers."""
    try:
        return Decimal(_get_setting("daily_prize_pool_cap_gd", "0") or "0")
    except Exception:
        return Decimal("0")


def update_daily_prize_pool_cap(value, admin_wallet: str) -> dict:
    try:
        cap = Decimal(str(value))
        if cap < 0:
            return {"success": False, "error": "Cap cannot be negative"}
        _set_setting("daily_prize_pool_cap_gd", str(cap), admin_wallet)
        return {"success": True, "cap_gd": str(cap)}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": str(exc)}


# ── Round / entry / win helpers ──────────────────────────────────────────────

def ensure_round_exists(round_id: int, game_date: str) -> None:
    """Create the round row if absent (idempotent)."""
    try:
        sb = _get_supabase_admin()
        sb.table("daily_lotto_rounds").upsert({
            "id": round_id,
            "game_date": game_date,
            "status": "pending",
        }, on_conflict="id").execute()
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ ensure_round_exists failed for %s: %s", round_id, exc)


def upsert_entry(
    round_id: int,
    wallet: str,
    numbers: list,
    signature: str | None = None,
    signed_message: str | None = None,
) -> dict:
    """Record a pick. Returns already_picked=True when the wallet already has
    an entry for this round (the UNIQUE constraint is the atomic guard)."""
    wallet = wallet.lower()
    if not numbers or len(numbers) != PICK_SIZE:
        return {"success": False, "error": f"Pick exactly {PICK_SIZE} digits."}
    try:
        sb = _get_supabase_admin()
        existing = sb.table("daily_lotto_entries") \
            .select("id") \
            .eq("round_id", round_id) \
            .eq("wallet_address", wallet) \
            .execute()
        if existing.data:
            return {
                "success": False,
                "error": "You already picked for today. Come back tomorrow!",
                "already_picked": True,
            }
        row = {
            "round_id": round_id,
            "wallet_address": wallet,
            "numbers": numbers,
            "created_at": _now_utc_iso(),
        }
        if signature:
            row["signature"] = signature
        if signed_message:
            row["signed_message"] = signed_message
        sb.table("daily_lotto_entries").insert(row).execute()
        return {"success": True}
    except Exception as exc:  # noqa: BLE001
        if "uq_lotto_entry_per_day" in str(exc).lower() or "duplicate" in str(exc).lower():
            return {
                "success": False,
                "error": "You already picked for today. Come back tomorrow!",
                "already_picked": True,
            }
        logger.error("❌ Failed to record lotto pick: %s", exc)
        return {"success": False, "error": str(exc)}


def get_entry(round_id: int, wallet: str):
    wallet = wallet.lower()
    try:
        sb = _get_supabase()
        res = sb.table("daily_lotto_entries") \
            .select("numbers, created_at") \
            .eq("round_id", round_id) \
            .eq("wallet_address", wallet) \
            .execute()
        if res.data:
            row = res.data[0]
            # Order is the pick (straight vs rumble) — never sort it.
            return {"numbers": [int(n) for n in row["numbers"]], "created_at": row.get("created_at")}
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ get_entry failed: %s", exc)
        return None


def get_round(round_id: int):
    try:
        sb = _get_supabase()
        res = sb.table("daily_lotto_rounds").select("*").eq("id", round_id).execute()
        return (res.data or [None])[0]
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ get_round failed: %s", exc)
        return None


def get_my_last_round_result(wallet: str) -> dict:
    """Explicit win/lose verdict for the user's most recent pick (the "You
    Won 🎉 / You Lost 😢" banner). Losers are never stored in
    daily_lotto_winnings, so the verdict is derived from the published draw.

    Returns ``{picked: False}`` when the wallet never picked, or
    ``{picked, round_id, game_date, pick, winning_numbers, match_count,
    result}`` where ``result`` is 'won' / 'lost' / 'pending'. ``amount_gd`` +
    ``win_status`` are attached only for wins (from the winnings row)."""
    wallet = wallet.lower()
    try:
        sb = _get_supabase()
        entries = sb.table("daily_lotto_entries") \
            .select("round_id, numbers, created_at, daily_lotto_rounds(game_date, winning_numbers)") \
            .eq("wallet_address", wallet) \
            .order("round_id", desc=True) \
            .limit(1) \
            .execute()
        if not entries.data:
            return {"picked": False}
        e = entries.data[0]
        linked = e.get("daily_lotto_rounds") or {}
        draw = linked.get("winning_numbers") if isinstance(linked, dict) else None
        win_type = classify_win(e["numbers"], draw) if draw else None
        result = classify_result(e["numbers"], draw)
        info = {
            "picked": True,
            "round_id": e["round_id"],
            "game_date": linked.get("game_date") if isinstance(linked, dict) else None,
            "pick": [int(n) for n in (e["numbers"] or [])],
            "winning_numbers": draw,
            "match_count": count_positions_matched(e["numbers"], draw) if draw else None,
            "win_type": win_type,
            "result": result,
        }
        if result == "won":
            wins = sb.table("daily_lotto_winnings") \
                .select("amount_gd, status") \
                .eq("round_id", e["round_id"]) \
                .eq("wallet_address", wallet) \
                .limit(1) \
                .execute()
            if wins.data:
                info["amount_gd"] = str(wins.data[0].get("amount_gd") or "0")
                info["win_status"] = wins.data[0].get("status", "pending")
        return info
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ get_my_last_round_result failed: %s", exc)
        return {"picked": False}


def digit_triplet(numbers) -> str:
    """Canonical 3-char string for a pick/draw ("057" keeps its leading zero)."""
    return "".join(str(int(n)) for n in numbers)


def count_positions_matched(pick: list, draw: list) -> int:
    """How many of the three positions match exactly (0-3)."""
    if not pick or not draw or len(pick) != PICK_SIZE or len(draw) != PICK_SIZE:
        return 0
    return sum(1 for p, d in zip(pick, draw) if int(p) == int(d))


def classify_win(pick: list | None, draw: list | None) -> str | None:
    """PCSO-style verdict for one pick against the drawn digits.

    Returns ``"straight"`` when every digit matches in the same order,
    ``"rumble"`` when the same three digits appear in any other order, and
    ``None`` when it loses. Repeated digits work: rumble compares multisets, so
    a pick of 1-1-2 rumbles a draw of 1-2-1, while 1-1-3 does not."""
    if not pick or not draw:
        return None
    if len(pick) != PICK_SIZE or len(draw) != PICK_SIZE:
        return None
    pick_digits = [int(x) for x in pick]
    draw_digits = [int(x) for x in draw]
    if pick_digits == draw_digits:
        return WIN_STRAIGHT
    if sorted(pick_digits) == sorted(draw_digits):
        return WIN_RUMBLE
    return None


def tier_match_count(win_type: str | None) -> int:
    """Map a win type onto the prize-tier key (the match_count slot)."""
    if win_type == WIN_STRAIGHT:
        return STRAIGHT_MATCH
    if win_type == WIN_RUMBLE:
        return RUMBLE_MATCH
    return 0


def classify_result(pick: list | None, winning_numbers: list | None) -> str:
    """Explicit per-pick verdict for the user: ``won`` (straight or rumble),
    ``lost`` or ``pending`` (round hasn't drawn / no drawn digits yet).

    Every pick has exactly one verdict once the digits are published. Losers are
    NOT stored in daily_lotto_winnings (only winners get rows), so the verdict is
    derived from the draw — never read from the winnings table."""
    if not pick or not winning_numbers:
        return "pending"
    return "won" if classify_win(pick, winning_numbers) else "lost"


def _compute_round_winners(round_id: int, winning_numbers: list) -> dict:
    """Compute winner rows for a round (used by the draw routine and the stuck
    recovery). Returns {winners: [{round_id, wallet_address, match_count,
    win_type, amount_gd}], tiers: {...}}."""
    draw = [int(x) for x in winning_numbers]
    if len(draw) != PICK_SIZE:
        return {"error": "Drawn digits are invalid.", "winners": [], "tiers": {}}
    if any(d < MIN_NUMBER or d > MAX_NUMBER for d in draw):
        return {"error": "Drawn digits must be 0-9.", "winners": [], "tiers": {}}

    tiers = get_prize_tiers(use_cache=False)

    sb = _get_supabase_admin()
    entries = sb.table("daily_lotto_entries") \
        .select("wallet_address, numbers") \
        .eq("round_id", round_id) \
        .execute()
    entry_rows = entries.data or []

    winners = []
    for entry in entry_rows:
        wallet = entry["wallet_address"].lower()
        numbers = entry.get("numbers")
        if not numbers:
            continue
        win_type = classify_win(numbers, draw)
        if not win_type:
            continue
        match_count = tier_match_count(win_type)
        amount = Decimal(str(tiers.get(match_count, "0")))
        if amount <= 0:
            continue
        winners.append({
            "round_id": round_id,
            "wallet_address": wallet,
            "match_count": match_count,
            "win_type": win_type,
            "amount_gd": amount,
        })

    # Optional daily prize-pool cap (prorated to protect the vault).
    cap = get_daily_prize_pool_cap()
    prorated = False
    if cap > 0 and winners:
        winners, prorated = apply_prize_pool_cap(winners, cap)

    return {"winners": winners, "tiers": tiers, "prorated": prorated}


def apply_prize_pool_cap(winners: list, cap: Decimal) -> tuple:
    """Prorate per-tier totals so the round's total never exceeds ``cap``.
    0 (or negative) means unlimited — never shrink. Round-robin decrement
    across winners keeps the distribution fair-ish without float loss biasing
    one wallet. Returns (winners, prorated_bool)."""
    total = sum((w["amount_gd"] for w in winners), Decimal("0"))
    if cap <= 0 or total <= cap:
        return winners, False

    granted = {w["wallet_address"]: w["amount_gd"] for w in winners}
    over = total - cap
    order = list(granted.keys())
    idx = 0
    while over > 0:
        wallet = order[idx % len(order)]
        cur = granted[wallet]
        if cur > 1:
            delta = min(over, 1)
            granted[wallet] = cur - delta
            over -= delta
        idx += 1
        # Guard against an infinite loop when every winner is at 1 G$.
        if idx > 1_000_000:
            break

    for w in winners:
        w["amount_gd"] = granted[w["wallet_address"]]
    return winners, True


def _write_winners(round_id: int, winners: list) -> None:
    """Persist winner rows (idempotent, keyed on round_id+wallet)."""
    if not winners:
        return
    sb = _get_supabase_admin()
    existing = sb.table("daily_lotto_winnings") \
        .select("wallet_address") \
        .eq("round_id", round_id) \
        .execute()
    existing_wallets = {r["wallet_address"].lower() for r in (existing.data or [])}
    rows = [w for w in winners if w["wallet_address"].lower() not in existing_wallets]
    if rows:
        sb.table("daily_lotto_winnings").insert(rows).execute()


# ── Draw routine (called by the scheduler and the admin manual-draw) ─────────

def run_draw_for_round(round_id: int) -> dict:
    """Compute + persist winning numbers and winner rows for a round.

    Called (a) by the scheduler when the draw time is reached, and (b) by an
    admin via the manual button. Both paths go through the same CAS so
    concurrent invocations are safe."""
    try:
        # CAS: pending -> drawing. Only the winner of this flip runs the draw.
        sb = _get_supabase_admin()
        res = sb.table("daily_lotto_rounds") \
            .update({"status": "drawing"}) \
            .eq("id", round_id) \
            .eq("status", "pending") \
            .execute()
        if not res.data:
            existing = get_round(round_id)
            # Already drawn or drawing; idempotent — recover winners if missing.
            if existing and existing.get("winning_numbers"):
                winners = _compute_round_winners(round_id, existing["winning_numbers"])
                _write_winners(round_id, winners["winners"])
                sb = _get_supabase_admin()
                sb.table("daily_lotto_rounds").update({"status": "completed"}).eq("id", round_id).execute()
                return {"success": True, "already_drawn": True, "round_id": round_id}
            return {"success": False, "error": "Round is not pending.", "already_drawn": True}

        # Generate the drawn digits with the CSPRNG-backed SystemRandom.
        # Plain random.choices is predictable (Mersenne Twister) — anyone
        # correlating the server clock could compute the draw. Each position is
        # drawn independently (digits may repeat, e.g. 7-7-7) and ORDER IS THE
        # RESULT: straight needs the same order, rumble any order.
        csprng = secrets.SystemRandom()
        numbers = [csprng.randrange(MIN_NUMBER, MAX_NUMBER + 1) for _ in range(PICK_SIZE)]
        seed = _seed_hash(numbers, round_id)

        # Compute winners + amounts (uses the admin-editable prize tiers).
        result = _compute_round_winners(round_id, numbers)
        if result.get("error"):
            # Roll the round back to pending so the scheduler can retry.
            sb.table("daily_lotto_rounds").update({"status": "pending"}).eq("id", round_id).execute()
            return {"success": False, "error": result["error"]}

        _write_winners(round_id, result["winners"])

        sb.table("daily_lotto_rounds").update({
            "winning_numbers": numbers,
            "seed_hash": seed,
            "status": "completed",
            "drawn_at": _now_utc_iso(),
            "completed_at": _now_utc_iso(),
            "prorated": result.get("prorated", False),
        }).eq("id", round_id).execute()

        logger.info(
            "🎰 Daily Lotto draw #%s = %s · %d winner(s) · prorated=%s",
            round_id, numbers, len(result["winners"]), result.get("prorated"),
        )
        return {
            "success": True,
            "round_id": round_id,
            "numbers": numbers,
            "winner_count": len(result["winners"]),
            "prorated": result.get("prorated", False),
        }
    except Exception as exc:  # noqa: BLE001
        logger.error("❌ run_draw_for_round %s failed: %s", round_id, exc)
        return {"success": False, "error": str(exc)}


def get_my_winnings(wallet: str, limit: int = 20) -> list:
    wallet = wallet.lower()
    try:
        sb = _get_supabase()
        res = sb.table("daily_lotto_winnings") \
            .select("*, daily_lotto_rounds(game_date, winning_numbers)") \
            .eq("wallet_address", wallet) \
            .order("round_id", desc=True) \
            .limit(limit) \
            .execute()
        return res.data or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ get_my_winnings failed: %s", exc)
        return []


def _short_wallet(wallet: str | None) -> str:
    """Truncate a wallet address for public display (leading 6 / trailing 4)."""
    if not wallet:
        return '???'
    wallet = str(wallet).strip().lower()
    if len(wallet) <= 12:
        return wallet
    return f"{wallet[:6]}...{wallet[-4:]}"


# ── Public participants feed (mirrors price_prediction's live feed) ──────────

def get_round_participants(round_id: int, wallet: str | None = None, limit: int = 60,
                           winning_numbers: list | None = None) -> dict:
    """Return the wallets (truncated) + numbers that picked this round, plus the
    total participant count for the day and an explicit won/lost verdict per
    row once the round has drawn.

    Wallet addresses are truncated server-side so no user ever sees another
    user's full address (same truncation convention as the Price Prediction
    live feed). The 6 picked numbers ARE shown next to each wallet — that is
    exactly what makes the lotto social: you can see who's in today, and which
    balls they chose, before the 8PM draw.

    ``winning_numbers`` (the published draw, when available) turns every row
    into a winner/loser verdict via the same ``classify_result`` used by the
    user's own history — losers have no winnings row, so the verdict MUST be
    derived from the draw and never from the winnings table. ``winner_count``
    is the number of winners in this round (badge on the header)."""
    round_id = int(round_id)
    if winning_numbers is None:
        # Self-sufficient: read the published draw for the round so callers
        # (page, future bot surfaces) get verdicts without passing it in.
        row = get_round(round_id) or {}
        winning_numbers = row.get('winning_numbers')
    draw = [int(n) for n in winning_numbers] if winning_numbers else None
    try:
        total = get_round_participant_count(round_id)

        sb = _get_supabase()
        res = sb.table("daily_lotto_entries") \
            .select("wallet_address, numbers, created_at") \
            .eq("round_id", round_id) \
            .order("created_at", desc=True) \
            .limit(limit) \
            .execute()
        rows = res.data or []

        # Amounts + grant status per winning wallet (winners only; a loser has
        # no row). Read once for the round so the badge can show the prize.
        win_by_wallet = {}
        if draw:
            try:
                wins = sb.table("daily_lotto_winnings") \
                    .select("wallet_address, amount_gd, status") \
                    .eq("round_id", round_id) \
                    .execute()
                for w in (wins.data or []):
                    win_by_wallet[(w.get("wallet_address") or '').lower()] = w
            except Exception as exc:  # noqa: BLE001
                logger.warning("⚠️ participants winnings read failed: %s", exc)

        my_wallet = (wallet or '').strip().lower()
        sanitized = []
        for row in rows:
            full = row.get("wallet_address") or ''
            key = full.lower()
            is_me = bool(my_wallet) and key == my_wallet
            verdict = classify_result(row.get("numbers"), draw)
            win = win_by_wallet.get(key) or {}
            sanitized.append({
                "wallet_short": _short_wallet(full),
                "is_me": is_me,
                "numbers": [int(n) for n in (row.get("numbers") or [])],
                "created_at": row.get("created_at"),
                "result": verdict,
                "is_winner": verdict == "won",
                "win_type": classify_win(row.get("numbers"), draw) if draw else None,
                "matched": count_positions_matched(row.get("numbers") or [], draw) if draw else None,
                "amount_gd": str(win.get("amount_gd")) if win.get("amount_gd") is not None else None,
                "win_status": win.get("status"),
            })

        return {
            "success": True,
            "round_id": round_id,
            "participants": sanitized,
            "total_participants": total,
            "truncated": total > limit,
            "drawn": bool(draw),
            "winning_numbers": draw,
            "winner_count": len(win_by_wallet),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ get_round_participants failed: %s", exc)
        return {"success": False, "error": str(exc), "round_id": round_id, "participants": [], "total_participants": 0}


def get_round_participant_count(round_id: int) -> int:
    """Total entries for a round, used by the public feed to show "N players"
    today. Runs on the service-role client so RLS can never hide rows."""
    round_id = int(round_id)
    try:
        sb = _get_supabase()
        res = sb.table("daily_lotto_entries") \
            .select("id") \
            .eq("round_id", round_id) \
            .execute()
        return len(res.data or [])
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ get_round_participant_count failed: %s", exc)
        return 0


def get_my_history(wallet: str, limit: int = 20) -> list:
    """Combined recent entries + matches + explicit win/lose verdict for the
    user page history."""
    wallet = wallet.lower()
    rows = []
    try:
        sb = _get_supabase()
        entries = sb.table("daily_lotto_entries") \
            .select("round_id, numbers, created_at, daily_lotto_rounds(game_date, winning_numbers)") \
            .eq("wallet_address", wallet) \
            .order("round_id", desc=True) \
            .limit(limit) \
            .execute()
        for e in (entries.data or []):
            linked = e.get("daily_lotto_rounds") or {}
            draw = linked.get("winning_numbers") if isinstance(linked, dict) else None
            rows.append({
                "round_id": e["round_id"],
                "game_date": linked.get("game_date") if isinstance(linked, dict) else None,
                "pick": [int(n) for n in (e["numbers"] or [])],
                "winning_numbers": draw,
                "match_count": count_positions_matched(e["numbers"], draw) if draw else None,
                "win_type": classify_win(e["numbers"], draw) if draw else None,
                "result": classify_result(e["numbers"], draw),
                "created_at": e.get("created_at"),
            })
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ get_my_history failed: %s", exc)
    return rows


# ── Vault alerts (proposer/admin notification when the vault is empty) ───────

_alert_lock = threading.Lock()
_last_alert_at: float = 0.0


def should_throttle_alert() -> bool:
    """True if an alert of this class was sent recently (rate limit)."""
    global _last_alert_at
    with _alert_lock:
        if time.time() - _last_alert_at < ALERT_THROTTLE_SEC:
            return True
        _last_alert_at = time.time()
        return False


def raise_vault_alert(round_id: int, winners: int, shortfall_gd) -> None:
    """Insert a vault-alert row + best-effort Telegram DM to every admin.

    Never raises. Throttled globally so a network of winners cannot drown the
    admin dashboard."""
    try:
        sb = _get_supabase_admin()
        if sb is None:
            return
        sb.table("daily_lotto_vault_alerts").insert({
            "round_id": round_id,
            "winners": int(winners or 0),
            "shortfall_gd": float(shortfall_gd) if shortfall_gd is not None else None,
            "message": f"Prize vault has no (or insufficient) G$ — {winners} winner(s) are waiting.",
            "resolved": False,
        }).execute()
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ Failed to write vault alert: %s", exc)

    try:
        from telegram_notify import notify_user_by_wallet_async
        for admin_wallet in get_admin_wallets():
            notify_user_by_wallet_async(
                admin_wallet,
                "⚠️ <b>GoodMarket Daily Lotto</b>: the prize vault has no G$ to pay winners. "
                f"{winners} winner(s) are waiting. Please top up G$ at the contract to continue payouts.",
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ Failed to send lotto vault Telegram alert: %s", exc)


def get_admin_wallets() -> list:
    """Wallets flagged is_admin in user_data (used for vault alerts)."""
    try:
        sb = _get_supabase_admin()
        if sb is None:
            return []
        res = sb.table("user_data").select("wallet_address").eq("is_admin", True).execute()
        return [r["wallet_address"] for r in (res.data or [])]
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ get_admin_wallets failed: %s", exc)
        return []


def list_vault_alerts(unresolved_only: bool = True, limit: int = 50) -> list:
    try:
        sb = _get_supabase()
        query = sb.table("daily_lotto_vault_alerts").select("*").order("created_at", desc=True)
        if unresolved_only:
            query = query.eq("resolved", False)
        res = query.limit(limit).execute()
        return res.data or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("⚠️ list_vault_alerts failed: %s", exc)
        return []


def resolve_vault_alert(alert_id: int, admin_wallet: str) -> dict:
    try:
        sb = _get_supabase_admin()
        if sb is None:
            return {"success": False, "error": "DB unavailable"}
        sb.table("daily_lotto_vault_alerts").update({"resolved": True}).eq("id", alert_id).execute()
        return {"success": True}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": str(exc)}


# ── Admin overview ───────────────────────────────────────────────────────────

def admin_overview() -> dict:
    """Aggregate stats for the admin dashboard section."""
    rounds_rows, tiers, alerts = [], {}, []
    total_winners = 0
    total_payout = Decimal("0")
    try:
        sb = _get_supabase_admin()
        rounds = sb.table("daily_lotto_rounds") \
            .select("id, game_date, status, grant_status, prorated, drawn_at") \
            .order("id", desc=True) \
            .limit(14) \
            .execute()
        rounds_rows = rounds.data or []

        wins = sb.table("daily_lotto_winnings").select("amount_gd") \
            .order("id", desc=True).limit(500).execute()
        for w in (wins.data or []):
            total_winners += 1
            total_payout += Decimal(str(w.get("amount_gd") or 0))

        tiers = get_prize_tiers(use_cache=False)
        alerts = list_vault_alerts(unresolved_only=True, limit=20)

        contract_balance = None
        try:
            from .blockchain import lotto_blockchain
            contract_balance = lotto_blockchain.get_contract_balance()
        except Exception as exc:  # noqa: BLE001
            logger.warning("⚠️ admin_overview contract balance read failed: %s", exc)

        return {
            "success": True,
            "rounds": rounds_rows,
            "tiers": {str(k): str(v) for k, v in tiers.items()},
            "total_winners_recent": total_winners,
            "total_payout_recent": str(total_payout),
            "alerts": alerts,
            "contract_balance": contract_balance,
        }
    except Exception as exc:  # noqa: BLE001
        logger.error("❌ admin_overview failed: %s", exc)
        return {"success": False, "error": str(exc), "rounds": [], "tiers": {}}
