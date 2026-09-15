"""Weekly withdrawal allowance for Play & Earn.

Play & Earn pays out at most ``WEEKLY_WITHDRAWAL_LIMIT`` G$ per wallet per week.
The week is measured on the Philippines clock (UTC+8, no DST) and runs Monday
00:00 to Sunday 23:59 PHT, so users can be told exactly when the allowance
refreshes.

Pure date/math helpers only — no supabase/web3 imports so the rules stay
testable without the backend dependencies.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

# PHT has no DST, so a fixed offset is exact and avoids tzdata dependencies.
PHT = timezone(timedelta(hours=8))

DEFAULT_WEEKLY_WITHDRAWAL_LIMIT = 500.0


def weekly_withdrawal_limit() -> float:
    """Weekly cap in G$ (env ``MINIGAME_WEEKLY_WITHDRAWAL_LIMIT``)."""
    raw = (os.getenv("MINIGAME_WEEKLY_WITHDRAWAL_LIMIT") or "").strip().strip("\"'`")
    if not raw:
        return DEFAULT_WEEKLY_WITHDRAWAL_LIMIT
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_WEEKLY_WITHDRAWAL_LIMIT
    return value if value > 0 else DEFAULT_WEEKLY_WITHDRAWAL_LIMIT


def pht_now(now=None) -> datetime:
    """Return ``now`` (or the current time) as a PHT-aware datetime."""
    if now is None:
        return datetime.now(timezone.utc).astimezone(PHT)
    if now.tzinfo is None:
        return now.replace(tzinfo=timezone.utc).astimezone(PHT)
    return now.astimezone(PHT)


def week_key(now=None) -> str:
    """ISO week key for the PHT calendar week, e.g. ``2026-W38``."""
    iso_year, iso_week, _ = pht_now(now).isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def week_reset_at(now=None) -> datetime:
    """Start of next week's allowance — the next Monday at 00:00 PHT."""
    local = pht_now(now)
    days_until_monday = (7 - local.weekday()) % 7 or 7
    return (local + timedelta(days=days_until_monday)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )


def week_start_date(now=None):
    """Calendar date of this week's Monday (PHT) — matches the payout log's DATE column."""
    local = pht_now(now)
    return (local - timedelta(days=local.weekday())).date()


def week_reset_label(now=None) -> str:
    """Human-readable reset time for user-facing copy."""
    return week_reset_at(now).strftime("%A, %d %b %Y at 12:00 AM PHT")


def weekly_limit_message(limit: float, now=None) -> str:
    """Message shown when the wallet has used up this week's allowance."""
    return (
        f"You've reached this week's {limit:,.0f} G$ withdrawal limit. "
        f"Please withdraw again next week — your allowance resets on "
        f"{week_reset_label(now)}."
    )
