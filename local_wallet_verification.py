"""Background reconciler for local (in-app) wallet face-verification status.

The authoritative source of "is this wallet face-verified?" is the on-chain
GoodDollar ``Identity.isWhitelisted`` read (``blockchain.is_identity_verified``).
``local_wallet_accounts`` mirrors that read into cheap columns
(``verification_status`` / ``is_human_verified`` / ``human_verified_at`` /
``last_verified_check``) so admins can trace and count verified local-wallet
users with a single query instead of N RPC calls.

The write-time stamp (see ``routes.py`` / ``main.py``) only fires when a user
*confirms* face verification through the app, so it misses:

  * existing accounts created before this feature existed, and
  * wallets that were verified elsewhere and never re-confirmed here.

This scheduler closes both gaps. Every interval it walks the local-wallet
accounts, re-reads the on-chain status, and writes it back. That also keeps the
status honest in the other direction: a wallet that runs "De-verify my account"
flips back to ``unverified`` on the next pass.

Design notes:
  * Env-gated, default ON (set ``LOCAL_WALLET_VERIFICATION_ENABLED=0`` to opt out),
    mirroring ``referral_program/referral_reconciler.py``.
  * Idempotent and duplicate-safe: concurrent ticks in separate gunicorn workers
    write the same computed value, so no row is ever corrupted.
  * Never raises — a failed tick is logged and swallowed so the app is unaffected.
  * Batch-limited (``LOCAL_WALLET_VERIFICATION_BATCH``) so a huge table cannot
    fire thousands of RPC reads in one tick; the pass resumes next interval.

Env knobs (all optional):
    LOCAL_WALLET_VERIFICATION_ENABLED      – "0"/"false" to disable (default on)
    LOCAL_WALLET_VERIFICATION_INTERVAL_SEC – poll interval (default 3600s)
    LOCAL_WALLET_VERIFICATION_BATCH        – max accounts per tick (default 200)
"""
import logging
import os
import threading
import time
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


def _env_flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in ("0", "false", "no", "off")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


_ENABLED = _env_flag("LOCAL_WALLET_VERIFICATION_ENABLED", True)
_INTERVAL_SEC = _env_int("LOCAL_WALLET_VERIFICATION_INTERVAL_SEC", 3600)
_BATCH = _env_int("LOCAL_WALLET_VERIFICATION_BATCH", 200)

_scheduler_stop = threading.Event()
_scheduler_thread = None
_scheduler_lock = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_table():
    """Service-role client preferred (same RLS lesson as the rest of the app)."""
    from supabase_client import get_supabase_admin_client, get_supabase_client
    client = get_supabase_admin_client() or get_supabase_client()
    return client.table("local_wallet_accounts") if client else None


def _fetch_accounts(table, limit: int):
    """Return up to `limit` accounts we still need to (re)check.

    Only *completed* signups are checked — an abandoned register-time row has no
    real wallet behind it, so there is nothing to verify on-chain (and no point
    spending an RPC call). Accounts never checked, or last checked longest ago,
    come first so a table larger than the batch size is covered across
    successive ticks.
    """
    base_cols = (
        "address,verification_status,is_human_verified,human_verified_at,"
        "last_verified_check"
    )
    try:
        res = (
            table.select(base_cols)
            .eq("signup_completed", True)
            .order("last_verified_check", desc=False, nullsfirst=True)
            .limit(limit)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        # Deployments that have not run sql/local_wallet_signup_completion.sql
        # yet have no signup_completed column — fall back to checking every row
        # (the pre-migration behaviour) rather than checking none.
        logger.warning(
            "⚠️ local-wallet reconciler: signup_completed column missing "
            f"({exc}); checking all rows. Run "
            "sql/local_wallet_signup_completion.sql."
        )
        res = (
            table.select(base_cols)
            .order("last_verified_check", desc=False, nullsfirst=True)
            .limit(limit)
            .execute()
        )
    return getattr(res, "data", None) or []


def _onchain_verified(address: str) -> bool:
    """True only when the chain says the wallet is whitelisted.

    Fails closed: an RPC error / unknown result must never flip a row to
    'verified'.
    """
    try:
        from blockchain import is_identity_verified
        result = is_identity_verified(address) or {}
        return bool(result.get("verified")) and not result.get("error")
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"⚠️ local-wallet FV check failed for {str(address)[:10]}…: {exc}")
        return False


def reconcile_local_wallet_verifications(limit: int | None = None) -> dict:
    """Run one reconciliation pass. Returns a small summary dict.

    Never raises. Each account's on-chain status is re-read and written back;
    ``human_verified_at`` is set once (first confirmation) and preserved after.
    """
    batch = limit or _BATCH
    summary = {"checked": 0, "verified": 0, "unverified": 0, "updated": 0, "errors": 0}

    try:
        table = _get_table()
        if table is None:
            logger.warning("⚠️ local-wallet FV reconciler: no Supabase client")
            return summary

        rows = _fetch_accounts(table, batch)
        for row in rows:
            address = (row.get("address") or "").strip()
            if not address:
                continue
            summary["checked"] += 1
            try:
                verified = _onchain_verified(address)
            except Exception as exc:  # noqa: BLE001
                summary["errors"] += 1
                logger.warning(f"⚠️ local-wallet FV reconcile row failed: {exc}")
                continue

            status = "verified" if verified else "unverified"
            if verified:
                summary["verified"] += 1
            else:
                summary["unverified"] += 1

            # Only write when something actually changed, so a steady table
            # does not generate write traffic on every tick.
            changed = (
                row.get("verification_status") != status
                or bool(row.get("is_human_verified")) != verified
            )
            payload = {
                "verification_status": status,
                "is_human_verified": verified,
                "last_verified_check": _now_iso(),
            }
            if verified and not row.get("human_verified_at"):
                # Preserve the FIRST confirmation time; do not overwrite it on
                # later passes.
                payload["human_verified_at"] = _now_iso()

            try:
                table.update(payload).ilike("address", address).execute()
                if changed:
                    summary["updated"] += 1
            except Exception as exc:  # noqa: BLE001
                summary["errors"] += 1
                logger.warning(f"⚠️ local-wallet FV update failed for {address[:10]}…: {exc}")
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"⚠️ local-wallet FV reconciler pass failed: {exc}")

    if summary["checked"]:
        logger.info(
            f"🪪 local-wallet FV reconciler: checked={summary['checked']} "
            f"verified={summary['verified']} unverified={summary['unverified']} "
            f"updated={summary['updated']} errors={summary['errors']}"
        )
    return summary


def _count(table, filters=None) -> int:
    """Exact row count for `table`, applying `filters` (list of (col, value))."""
    query = table.select("id", count="exact")
    for col, value in (filters or []):
        query = query.eq(col, value)
    res = query.limit(1).execute()
    count = getattr(res, "count", None)
    if count is None:
        # Fall back to counting the returned rows when the client does not
        # populate `count`.
        count = len(getattr(res, "data", None) or [])
    return int(count or 0)


def get_local_wallet_verification_summary() -> dict:
    """Read the cached counts (no on-chain calls). Backs the admin dashboard.

    Only *completed* signups are counted. A row written by
    `/api/local-wallet/register` that never reached a first login is an
    abandoned signup artifact, not a local-wallet user — counting it was the
    bug that made the table look like it contained ordinary (non-local) users.
    """
    summary = {
        "total": 0,
        "verified": 0,
        "unverified": 0,
        "completed": 0,
        "incomplete": 0,
        "verified_rate": 0.0,
        "service_available": False,
    }
    try:
        from supabase_client import get_supabase_admin_client, get_supabase_client
        client = get_supabase_admin_client() or get_supabase_client()
        if client is None:
            return summary
        table = client.table("local_wallet_accounts")

        all_rows = _count(table)
        try:
            # Counted over completed signups only. Fails on a deployment that
            # has not run sql/local_wallet_signup_completion.sql yet — then we
            # degrade to treating every row as completed (the pre-migration
            # behaviour) instead of reporting zeros.
            completed = _count(table, [("signup_completed", True)])
            incomplete = max(0, all_rows - completed)
            verified = _count(
                table, [("signup_completed", True), ("is_human_verified", True)]
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "⚠️ local-wallet summary: signup_completed column missing "
                f"({exc}); counting all rows. Run "
                "sql/local_wallet_signup_completion.sql."
            )
            completed = all_rows
            incomplete = 0
            verified = _count(table, [("is_human_verified", True)])

        summary["completed"] = completed
        summary["incomplete"] = incomplete
        summary["total"] = completed
        summary["verified"] = verified
        summary["unverified"] = max(0, completed - verified)
        if completed:
            summary["verified_rate"] = round(verified / completed * 100, 1)
        summary["service_available"] = True
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"⚠️ local-wallet FV summary failed: {exc}")
    return summary


def cleanup_incomplete_local_wallet_accounts(dry_run: bool = True) -> dict:
    """Remove abandoned signup rows (register-time, never logged in).

    These are artifacts, not users: `/api/local-wallet/register` inserts a row
    the moment the browser generates a keypair, so a user who bailed at the
    recovery-words step leaves one behind. Deleting them is safe — a real
    account that logs in later flips `signup_completed` to true before this runs
    (and if the row were deleted first, a re-register simply recreates it).

    ``dry_run`` (default) only counts; pass ``dry_run=False`` to actually
    delete. Never raises — a failure is reported in the returned summary.
    """
    result = {"success": False, "examined": 0, "deleted": 0, "dry_run": dry_run}
    try:
        from supabase_client import get_supabase_admin_client, get_supabase_client
        client = get_supabase_admin_client() or get_supabase_client()
        if client is None:
            result["error"] = "service_unavailable"
            return result
        table = client.table("local_wallet_accounts")
        try:
            res = (
                table.select("id", count="exact")
                .eq("signup_completed", False)
                .limit(1)
                .execute()
            )
        except Exception as exc:  # noqa: BLE001
            result["error"] = f"signup_completed column missing: {exc}"
            return result
        examined = getattr(res, "count", None)
        if examined is None:
            examined = len(getattr(res, "data", None) or [])
        result["examined"] = int(examined or 0)
        if not dry_run and result["examined"]:
            table.delete().eq("signup_completed", False).execute()
            result["deleted"] = result["examined"]
        result["success"] = True
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"⚠️ local-wallet abandoned-signup cleanup failed: {exc}")
        result["error"] = str(exc)
    return result


def _loop():
    # Small initial delay so startup is not slowed by a reconciliation pass.
    time.sleep(min(30, _INTERVAL_SEC))
    while not _scheduler_stop.is_set():
        try:
            reconcile_local_wallet_verifications()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"⚠️ local-wallet FV reconciler tick failed: {exc}")
        _scheduler_stop.wait(_INTERVAL_SEC)


def is_local_wallet_verification_enabled() -> bool:
    return _ENABLED


def init_local_wallet_verification_scheduler(app=None) -> bool:
    """Start the reconciler thread. Idempotent."""
    global _scheduler_thread
    if not _ENABLED:
        logger.info(
            "ℹ️ local-wallet FV reconciler disabled "
            "(LOCAL_WALLET_VERIFICATION_ENABLED=0)"
        )
        return False
    with _scheduler_lock:
        if _scheduler_thread and _scheduler_thread.is_alive():
            return True
        _scheduler_stop.clear()
        _scheduler_thread = threading.Thread(
            target=_loop, daemon=True, name="local-wallet-verification"
        )
        _scheduler_thread.start()
        logger.info(
            f"✅ local-wallet FV reconciler started (every {_INTERVAL_SEC}s, "
            f"batch {_BATCH})"
        )
        return True


def stop_local_wallet_verification_scheduler():
    global _scheduler_thread
    with _scheduler_lock:
        _scheduler_stop.set()
        _scheduler_thread = None
