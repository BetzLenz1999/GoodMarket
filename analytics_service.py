import logging
import json
from supabase_client import supabase_logger
from datetime import datetime, timedelta

from env_utils import get_env_float

logger = logging.getLogger(__name__)

# PostgREST caps a single response at ~1000 rows, so any platform-wide total
# must page through `.range()` windows or it silently reports a truncated sum.
_DISBURSEMENT_PAGE_SIZE = 1000


def _disbursement_client():
    """Supabase client for platform-wide payout reads.

    Prefers the service-role client: these ledgers have RLS enabled, and the
    anon role can be denied SELECT, which used to make a feature silently
    report 0 G$ disbursed. Falls back to the anon client so a deployment
    without ``SUPABASE_SERVICE_ROLE_KEY`` keeps working.
    """
    try:
        from supabase_client import (
            get_supabase_admin_client,
            supabase,
            supabase_enabled,
        )
    except Exception as e:
        logger.error(f"disbursements: supabase import failed: {e}")
        return None

    if not supabase_enabled:
        return None

    try:
        admin_client = get_supabase_admin_client()
    except Exception as e:
        logger.warning(f"disbursements: service-role client unavailable: {e}")
        admin_client = None

    if admin_client is None:
        logger.warning(
            "disbursements: SUPABASE_SERVICE_ROLE_KEY not set — reading with "
            "the anon client; RLS may hide payout rows."
        )
    return admin_client or supabase


def _apply_disbursement_filters(query, filters):
    for column, value in filters or []:
        if isinstance(value, tuple):
            operator, operand = value
            if operator == 'in':
                query = query.in_(column, operand)
            elif operator == 'gte':
                query = query.gte(column, operand)
            elif operator == 'lte':
                query = query.lte(column, operand)
            elif operator == 'lt':
                query = query.lt(column, operand)
            elif operator == 'neq':
                query = query.neq(column, operand)
            else:
                query = query.eq(column, operand)
        else:
            query = query.eq(column, value)
    return query


def _read_all_rows(client, table_name, columns, filters=None,
                   order_columns=None, page_size=_DISBURSEMENT_PAGE_SIZE):
    """Read every matching row, paging past the PostgREST response cap.

    ``order_columns`` is a candidate list: a stable order is what makes paging
    correct, so each candidate is tried in turn (a column may not exist on an
    older deployment) before falling back to an unordered single pass. Raises
    when every candidate fails so callers can distinguish "no rows" from
    "could not read".
    """
    if not order_columns:
        candidates = [None]
    elif isinstance(order_columns, str):
        candidates = [order_columns, None]
    else:
        candidates = list(order_columns) + [None]

    last_error = None
    for order_column in candidates:
        try:
            rows = []
            offset = 0
            while True:
                query = _apply_disbursement_filters(
                    client.table(table_name).select(columns), filters
                )
                if order_column:
                    query = query.order(order_column, desc=False)
                result = query.range(offset, offset + page_size - 1).execute()
                page = result.data or []
                rows.extend(page)
                if len(page) < page_size:
                    break
                offset += page_size
            return rows
        except Exception as e:
            last_error = e
            if order_column is not None:
                logger.warning(
                    f"disbursements: {table_name} ordered by {order_column} "
                    f"failed ({e}); trying next ordering"
                )

    raise last_error if last_error else RuntimeError(
        f"disbursements: {table_name} read failed"
    )


def _paginate_disbursement_rows(client, table_name, columns, filters=None,
                                order_columns=None):
    """Safe wrapper around :func:`_read_all_rows` — returns [] on failure."""
    try:
        return _read_all_rows(
            client, table_name, columns,
            filters=filters, order_columns=order_columns,
        )
    except Exception as e:
        logger.warning(f"disbursements: {table_name} read failed: {e}")
        return []


def _paginate_optional_status(client, table_name, columns, filters,
                              order_columns=None):
    """Read with a status filter, retrying unfiltered if the column is absent.

    Ledgers like ``minigame_withdrawals_log`` gained their ``status`` column in
    a later migration, so a strict filter would error (and silently zero the
    feature) on an older deployment. These rows are only ever written after a
    confirmed on-chain payout, so falling back to an unfiltered read is still
    counting real disbursements.
    """
    try:
        return _read_all_rows(
            client, table_name, columns,
            filters=filters, order_columns=order_columns,
        )
    except Exception as e:
        logger.warning(
            f"disbursements: {table_name} status filter unavailable ({e}); "
            f"reading without it"
        )

    # The column itself may be missing, so drop it from the projection too.
    fallback_columns = ', '.join(
        part.strip() for part in columns.split(',')
        if part.strip() and part.strip() != 'status'
    ) or '*'

    try:
        return _read_all_rows(
            client, table_name, fallback_columns,
            filters=None, order_columns=order_columns,
        )
    except Exception as e:
        logger.warning(f"disbursements: {table_name} read failed: {e}")
        return []


def _row_amount(row, *columns):
    """First numeric value present among ``columns`` on a row (0.0 if none)."""
    for column in columns:
        raw = row.get(column)
        if raw is None or raw == '':
            continue
        try:
            return float(raw)
        except (ValueError, TypeError):
            logger.warning(f"⚠️ Invalid {column} value in disbursement row: {raw}")
            return 0.0
    return 0.0


def _sum_amount(rows, *columns):
    return sum(_row_amount(row, *columns) for row in rows or [])


def _is_completed_payout(row):
    """True when a payout-ledger row represents a finished transfer.

    These ledgers are written only after the on-chain transfer succeeds, and
    legacy rows predate the status column — so a missing status counts as
    completed while an explicit pending/failed/rejected value does not.
    """
    status = str(row.get('status') or '').strip().lower()
    if not status:
        return True
    return status in (
        'completed', 'complete', 'success', 'successful', 'paid', 'sent',
    )


def _configured_gd_usd_price() -> float:
    """G$ price in USD from the operator-set ``GD_USD_PRICE`` env var.

    Deliberately env-only: G$ pricing in this app is operator-controlled (see
    ``blockchain._get_gd_usd_price``), so the homepage USD figure uses the same
    rate as the wallet balances instead of a market feed. Returns 0.0 when the
    var is missing/invalid, which the caller renders as "no USD value".
    """
    price = get_env_float("GD_USD_PRICE", 0.0)
    return price if price > 0 else 0.0


class AnalyticsService:
    def __init__(self):
        self.user_sessions = {}
        self.verification_attempts = {}
        self.dashboard_metrics = {
            "total_users": 0,
            "successful_verifications": 0,
            "failed_verifications": 0,
            "active_sessions": 0
        }
        self.supabase_logger = supabase_logger
        self._cache = {}
        self._cache_times = {}

    def track_verification_attempt(self, wallet_address: str, success: bool, face_verified: bool = False):
        """Track verification attempts for analytics.
        
        face_verified=True means the user actually completed GoodDollar face verification.
        """
        if wallet_address not in self.verification_attempts:
            self.verification_attempts[wallet_address] = {
                "attempts": 0,
                "successes": 0,
                "last_attempt": None
            }

        self.verification_attempts[wallet_address]["attempts"] += 1
        if success:
            self.verification_attempts[wallet_address]["successes"] += 1
            self.dashboard_metrics["successful_verifications"] += 1
        else:
            self.dashboard_metrics["failed_verifications"] += 1

        self.verification_attempts[wallet_address]["last_attempt"] = self._get_timestamp()

        # Log to Supabase using new structure (with null check)
        if self.supabase_logger:
            self.supabase_logger.log_verification_attempt(
                wallet_address,
                success,
                {"attempts": self.verification_attempts[wallet_address]["attempts"], "disbursement_method": "direct_private_key"},
                face_verified=face_verified
            )

    def track_user_session(self, wallet_address: str):
        """Track active user sessions"""
        if wallet_address not in self.user_sessions:
            self.dashboard_metrics["total_users"] += 1

        session_data = {
            "login_time": self._get_timestamp(),
            "last_activity": self._get_timestamp(),
            "page_views": 1
        }

        self.user_sessions[wallet_address] = session_data
        self.dashboard_metrics["active_sessions"] += 1

        # Log to Supabase using new structure (with null check)
        if self.supabase_logger:
            self.supabase_logger.log_login(wallet_address, session_data)

    def track_page_view(self, wallet_address: str, page: str):
        """Track page views for user engagement"""
        if wallet_address in self.user_sessions:
            self.user_sessions[wallet_address]["last_activity"] = self._get_timestamp()
            self.user_sessions[wallet_address]["page_views"] += 1

            if "pages_visited" not in self.user_sessions[wallet_address]:
                self.user_sessions[wallet_address]["pages_visited"] = []

            page_data = {
                "page": page,
                "timestamp": self._get_timestamp()
            }

            self.user_sessions[wallet_address]["pages_visited"].append(page_data)

            # Log to Supabase (with null check)
            if self.supabase_logger:
                self.supabase_logger.log_page_view(wallet_address, page, page_data)

    def get_user_analytics(self, wallet_address: str):
        """Get analytics data for a specific user"""
        user_data = {
            "wallet": wallet_address,
            "session_data": self.user_sessions.get(wallet_address, {}),
            "verification_history": self.verification_attempts.get(wallet_address, {}),
            "engagement_score": self._calculate_engagement_score(wallet_address)
        }
        return user_data

    def get_global_analytics(self):
        """Get global platform analytics synced from Supabase"""
        cached = self._get_cached("global_analytics", ttl_seconds=300)
        if cached:
            return cached

        # Get comprehensive data from Supabase
        supabase_stats = self.supabase_logger.get_analytics_summary()

        # Get Learn & Earn specific data
        learn_earn_stats = self._get_learn_earn_stats()

        # Get total disbursements data
        disbursements_stats = self._get_total_disbursements_stats()

        # Combine all data sources
        total_users = supabase_stats.get("total_users", 0)
        verified_users = supabase_stats.get("verified_users", 0)
        face_verified_total = supabase_stats.get("face_verified_total", verified_users)
        total_page_views = supabase_stats.get("total_page_views", 0)
        goodmarket_verified_users = supabase_stats.get("goodmarket_verified_users", 0)
        pending_verification_users = supabase_stats.get("pending_verification_users", 0)
        goodmarket_conversion_rate = supabase_stats.get("goodmarket_conversion_rate", "0%")
        goodmarket_total_claims = supabase_stats.get("goodmarket_total_claims", 0)
        goodmarket_unique_claimers = supabase_stats.get("goodmarket_unique_claimers", 0)

        # Get telegram task stats
        telegram_task_stats = self._get_telegram_task_stats()

        result = {
            "metrics": {
                "total_users": total_users,
                "successful_verifications": verified_users,
                "face_verified_total": face_verified_total,
                "failed_verifications": self.dashboard_metrics["failed_verifications"],
                "active_sessions": len(self.user_sessions),
                "learn_earn_users": learn_earn_stats.get("total_quiz_takers", 0),
                "telegram_task_users": telegram_task_stats.get("total_claimers", 0),
                "goodmarket_verified_users": goodmarket_verified_users,
                "pending_verification_users": pending_verification_users,
                "goodmarket_conversion_rate": goodmarket_conversion_rate,
                "goodmarket_total_claims": goodmarket_total_claims,
                "goodmarket_unique_claimers": goodmarket_unique_claimers
            },
            "user_activity": {
                "active_users_count": total_users,
                "total_page_views": total_page_views,
                "average_session_length": self._calculate_avg_session_length(),
                "learn_earn_completions": learn_earn_stats.get("total_quizzes", 0)
            },
            "verification_stats": {
                "success_rate": supabase_stats.get("verification_rate", self._calculate_success_rate()),
                "unique_wallets_attempted": total_users
            },
            "disbursement_analytics": {
                "total_g_disbursed": disbursements_stats.get("total_g_disbursed", 0),
                "total_g_disbursed_formatted": disbursements_stats.get("total_g_disbursed_formatted", "0 G$"),
                "breakdown": disbursements_stats.get("breakdown", {}),
                "breakdown_formatted": disbursements_stats.get("breakdown_formatted", {}),
                "platform_breakdown": {
                    "learn_earn": disbursements_stats.get("learn_earn_total", 0),
                    "forum_rewards": disbursements_stats.get("forum_rewards_total", 0),
                    "task_completion": disbursements_stats.get("task_completion_total", 0)
                }
            }
        }
        self._set_cache("global_analytics", result)
        return result

    def _get_learn_earn_stats(self):
        """Get Learn & Earn statistics from Supabase"""
        cached = self._get_cached("learn_earn_stats", ttl_seconds=300)
        if cached:
            return cached

        try:
            from supabase_client import supabase, supabase_enabled

            if not supabase_enabled:
                return {"total_quiz_takers": 0, "total_quizzes": 0}

            # Get unique quiz takers
            quiz_users = supabase.table('learnearn_log').select('wallet_address').execute()
            unique_quiz_takers = len(set(user['wallet_address'] for user in quiz_users.data)) if quiz_users.data else 0

            # Get total completed quizzes
            total_quizzes = len(quiz_users.data) if quiz_users.data else 0

            result = {
                "total_quiz_takers": unique_quiz_takers,
                "total_quizzes": total_quizzes
            }
            self._set_cache("learn_earn_stats", result)
            return result

        except Exception as e:
            print(f"❌ Error getting Learn & Earn stats: {e}")
            return {"total_quiz_takers": 0, "total_quizzes": 0}


    def _get_telegram_task_stats(self):
        """Get Telegram Task statistics from Supabase"""
        cached = self._get_cached("telegram_task_stats", ttl_seconds=300)
        if cached:
            return cached

        try:
            from supabase_client import supabase, supabase_enabled

            if not supabase_enabled:
                return {"total_claimers": 0, "total_claims": 0, "total_amount": 0}

            # Get all Telegram Task claims
            task_logs = supabase.table('telegram_task_log')\
                .select('wallet_address, reward_amount, created_at')\
                .eq('status', 'completed')\
                .execute()

            if not task_logs.data:
                return {"total_claimers": 0, "total_claims": 0, "total_amount": 0}

            # Get unique task claimers
            unique_claimers = len(set(user['wallet_address'] for user in task_logs.data))

            # Get total task claims
            total_claims = len(task_logs.data)

            # Calculate total amount disbursed
            total_amount = sum(float(log.get('reward_amount', 0)) for log in task_logs.data)

            logger.info(f"📊 Telegram Task Stats: {unique_claimers} claimers, {total_claims} claims, {total_amount} G$")

            result = {
                "total_claimers": unique_claimers,
                "total_claims": total_claims,
                "total_amount": total_amount
            }
            self._set_cache("telegram_task_stats", result)
            return result

        except Exception as e:
            logger.error(f"❌ Error getting Telegram Task stats: {e}")
            return {"total_claimers": 0, "total_claims": 0, "total_amount": 0}

    def get_gooddollar_insights(self):
        """Generate GoodDollar-specific insights from real data"""
        cached = self._get_cached("gooddollar_insights", ttl_seconds=300)
        if cached:
            return cached

        # Get real data from Supabase
        real_stats = self.supabase_logger.get_ubi_statistics()

        # Get additional platform stats
        learn_earn_stats = self._get_learn_earn_stats()

        # Get total G$ disbursements across all platforms
        total_disbursements_stats = self._get_total_disbursements_stats()

        insights = {
            "network_status": "🟢 Active",
            "estimated_users": real_stats.get("total_verified_users", "Loading..."),
            "daily_claims": real_stats.get("daily_ubi_claims", "Loading..."),
            "community_growth": real_stats.get("growth_rate", "Loading..."),
            "top_countries": real_stats.get("top_countries", ["Loading..."]),
            "platform_features": {
                "learn_earn_users": learn_earn_stats.get("total_quiz_takers", 0),
                "total_feature_users": learn_earn_stats.get("total_quiz_takers", 0)
            },
            "total_disbursements": total_disbursements_stats
        }
        self._set_cache("gooddollar_insights", insights)
        return insights

    def get_homepage_public_stats(self):
        """Public stats for the homepage hero (no auth required).

        Returns total G$ disbursed (from disbursement analytics), unique active
        earners aggregated across every G$-earning feature on the platform, and
        the number of daily-task completions in the last 30 days.
        """
        cached = self._get_cached("homepage_public_stats", ttl_seconds=300)
        if cached:
            return cached

        total_g_disbursed = 0.0
        total_g_disbursed_formatted = "0 G$"
        total_g_disbursed_usd = 0.0
        total_g_disbursed_usd_formatted = ""
        try:
            disbursements_stats = self._get_total_disbursements_stats()
            total_g_disbursed = float(disbursements_stats.get("total_g_disbursed", 0) or 0)
            total_g_disbursed_formatted = self._format_compact_number(total_g_disbursed) + " G$"
        except Exception as e:
            logger.error(f"homepage_public_stats: disbursements failed: {e}")

        # USD value of the distributed total, at the operator-set GD_USD_PRICE
        # rate. Omitted (empty string) when no price is configured so the hero
        # never shows a fabricated "$0.00".
        gd_usd_price = _configured_gd_usd_price()
        if gd_usd_price > 0 and total_g_disbursed > 0:
            total_g_disbursed_usd = total_g_disbursed * gd_usd_price
            total_g_disbursed_usd_formatted = self._format_compact_usd(total_g_disbursed_usd)

        active_earners = self._count_active_earners_across_features()
        tasks_last_30_days = self._count_daily_tasks_last_30_days()
        week_growth_pct = self._compute_disbursement_week_growth_pct()

        result = {
            "total_g_disbursed": total_g_disbursed,
            "total_g_disbursed_formatted": total_g_disbursed_formatted,
            "total_g_disbursed_usd": total_g_disbursed_usd,
            "total_g_disbursed_usd_formatted": total_g_disbursed_usd_formatted,
            "gd_usd_price": gd_usd_price,
            "total_g_disbursed_week_growth_pct": week_growth_pct,
            "active_earners": active_earners,
            "active_earners_formatted": f"{active_earners:,}",
            "tasks_last_30_days": tasks_last_30_days,
            "tasks_last_30_days_formatted": f"{tasks_last_30_days:,}",
        }
        self._set_cache("homepage_public_stats", result)
        return result

    def _format_compact_usd(self, value):
        """Format a USD amount compactly, e.g. ``$1.42K`` / ``$2.84M``.

        Values under $1 are shown with cent precision; the G$ rate is small, so
        a headline figure can legitimately land below a dollar.
        """
        try:
            n = float(value)
        except (TypeError, ValueError):
            return "$0"
        if n <= 0:
            return "$0"
        sign = "-" if n < 0 else ""
        n = abs(n)
        if n >= 1_000_000_000:
            return f"{sign}${n / 1_000_000_000:.2f}B"
        if n >= 1_000_000:
            return f"{sign}${n / 1_000_000:.2f}M"
        if n >= 10_000:
            return f"{sign}${n / 1_000:.1f}K"
        if n >= 1_000:
            return f"{sign}${n:,.0f}"
        if n >= 1:
            return f"{sign}${n:,.2f}"
        return f"{sign}${n:.4f}"

    def _format_compact_number(self, value):
        """Format a number into a compact human-readable string (e.g. 2.84M)."""
        try:
            n = float(value)
        except (TypeError, ValueError):
            return "0"
        sign = "-" if n < 0 else ""
        n = abs(n)
        if n >= 1_000_000_000:
            return f"{sign}{n / 1_000_000_000:.2f}B"
        if n >= 1_000_000:
            return f"{sign}{n / 1_000_000:.2f}M"
        if n >= 10_000:
            return f"{sign}{n / 1_000:.1f}K"
        if n >= 1_000:
            return f"{sign}{n:,.0f}"
        return f"{sign}{n:,.0f}"

    def _count_active_earners_across_features(self):
        """Union of unique wallet addresses across every earning feature.

        Reads with the service-role client and pages through every row: the
        anon client can be denied SELECT by RLS, and a single unpaged request
        stops at PostgREST's ~1000-row cap, so wallets beyond the first page
        used to be silently missing from the count.
        """
        try:
            from supabase_client import supabase_enabled
        except Exception as e:
            logger.error(f"active earners: supabase import failed: {e}")
            return 0

        if not supabase_enabled:
            return 0

        client = _disbursement_client()
        if client is None:
            logger.error("active earners: no Supabase client available")
            return 0

        unique_wallets = set()
        feature_tables = [
            ("learnearn_log", None),
            ("twitter_task_log", ("status", "completed")),
            ("telegram_task_log", ("status", "completed")),
            ("minigame_rewards_log", None),
            ("minigame_balances", None),
            ("community_stories_submissions", None),
            ("voucher_claims_log", None),
            ("achievement_card_sales", None),
            ("referral_rewards_log", ("status", "completed")),
        ]
        for table_name, eq_filter in feature_tables:
            try:
                rows = _paginate_disbursement_rows(
                    client, table_name, "wallet_address",
                    filters=[eq_filter] if eq_filter else None,
                )
                for row in rows:
                    wallet = row.get("wallet_address")
                    if wallet:
                        unique_wallets.add(wallet.lower())
            except Exception as e:
                logger.warning(f"active earners: skip {table_name}: {e}")
        return len(unique_wallets)

    def _count_daily_tasks_last_30_days(self):
        """Number of completed daily-task entries in the last 30 days."""
        try:
            from supabase_client import supabase, supabase_enabled
        except Exception as e:
            logger.error(f"daily tasks: supabase import failed: {e}")
            return 0

        if not supabase_enabled:
            return 0

        cutoff = (datetime.utcnow() - timedelta(days=30)).isoformat()
        total = 0
        for table_name in ("twitter_task_log", "telegram_task_log"):
            try:
                result = (
                    supabase.table(table_name)
                    .select("id", count="exact")
                    .eq("status", "completed")
                    .gte("created_at", cutoff)
                    .execute()
                )
                count = getattr(result, "count", None)
                if count is None:
                    count = len(result.data or [])
                total += int(count or 0)
            except Exception as e:
                logger.warning(f"daily tasks: skip {table_name}: {e}")
        return total

    def _compute_disbursement_week_growth_pct(self):
        """Week-over-week growth (%) of total disbursed G$.

        Compares the most recent 7 days (`weekly_breakdown`) against the
        average prior week over the rest of the reporting period (derived from
        `monthly_breakdown` and `monthly_date_range`). Returns None when there
        isn't enough history to make a meaningful comparison so the UI can
        fall back to a neutral label instead of showing fabricated growth.
        """
        try:
            stats = self._get_total_disbursements_stats()
            weekly = stats.get("weekly_breakdown") or {}
            monthly = stats.get("monthly_breakdown") or {}
            date_range = stats.get("monthly_date_range") or {}

            def _sum(d):
                if not isinstance(d, dict):
                    return 0.0
                total = 0.0
                for v in d.values():
                    try:
                        total += float(v or 0)
                    except (TypeError, ValueError):
                        continue
                return total

            this_week = _sum(weekly)
            month_total = _sum(monthly)
            if this_week <= 0 or month_total <= this_week:
                return None

            def _parse_date(value):
                if not value:
                    return None
                value = str(value)
                for fmt in ("%b %d, %Y", "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S"):
                    try:
                        return datetime.strptime(value, fmt)
                    except ValueError:
                        continue
                try:
                    return datetime.fromisoformat(value)
                except ValueError:
                    return None

            start = _parse_date(date_range.get("start_date"))
            end = _parse_date(date_range.get("end_date"))
            period_days = max((end - start).days, 0) if start and end else 0

            prior_days = period_days - 7
            if prior_days < 7:
                return None

            prior_total = month_total - this_week
            avg_prior_week = prior_total / (prior_days / 7.0)
            if avg_prior_week <= 0:
                return None

            return round(((this_week - avg_prior_week) / avg_prior_week) * 100.0, 1)
        except Exception as e:
            logger.debug(f"week growth pct: {e}")
        return None

    def _get_cached(self, key, ttl_seconds=60):
        """Get value from cache if it exists and hasn't expired"""
        if key in self._cache:
            cache_time = self._cache_times.get(key)
            if cache_time and (datetime.now() - cache_time).total_seconds() < ttl_seconds:
                return self._cache[key]
        return None

    def _set_cache(self, key, value):
        """Store value in cache with current timestamp"""
        self._cache[key] = value
        self._cache_times[key] = datetime.now()

    def get_dashboard_stats(self, wallet_address: str = None):
        """Get stats for dashboard display with Supabase sync"""
        cache_key = f"dashboard_stats_{wallet_address}" if wallet_address else "dashboard_stats_guest"
        cached = self._get_cached(cache_key, ttl_seconds=300)
        if cached:
            return cached

        if wallet_address:
            local_user_stats = self.get_user_analytics(wallet_address)

            supabase_user_stats = self.supabase_logger.get_user_stats(wallet_address)
            user_info = supabase_user_stats.get("user_info", {})
            user_feature_stats = self._get_user_feature_participation(wallet_address)
            platform_stats = self.get_global_analytics()
            disbursement_analytics = self._get_total_disbursements_stats()
            gooddollar_info = self.get_gooddollar_insights()

            result = {
                "user_stats": {
                    "sessions": user_info.get("total_sessions", len(local_user_stats["session_data"])),
                    "page_views": user_info.get("total_page_views", local_user_stats["session_data"].get("page_views", 0)),
                    "engagement": local_user_stats["engagement_score"],
                    "member_since": user_info.get("first_login", local_user_stats["session_data"].get("login_time", "Today")),
                    "learn_earn_quizzes": user_feature_stats.get("learn_earn_quizzes", 0),
                    "total_rewards_earned": user_feature_stats.get("total_rewards", 0)
                },
                "gooddollar_info": gooddollar_info,
                "platform_stats": platform_stats,
                "disbursement_analytics": disbursement_analytics
            }
            self._set_cache(cache_key, result)
            return result
        else:
            # Support guest users (when wallet_address is None)
            # Return default stats for guests
            result = {
                "user_stats": {
                    "page_views": 0,
                    "learn_earn_quizzes": 0,
                    "telegram_task_claims": 0,
                    "total_rewards_earned": "0 G$",
                    "member_since": "Guest"
                },
                "platform_stats": self._get_platform_stats(),
                "gooddollar_info": self._get_gooddollar_info(),
                "disbursement_analytics": self._get_total_disbursements_stats()
            }
            self._set_cache(cache_key, result)
            return result


    def _get_total_disbursements_stats(self):
        """Get total G$ disbursements across all platform tables"""
        try:
            from supabase_client import supabase_enabled
            from datetime import datetime, timedelta
            import time

            # Cache results for 15 minutes
            cache_key = '_disbursement_stats_cache'
            cache_duration = 900  # 15 minutes (increased from 5)

            if hasattr(self, cache_key):
                cached_data, cached_time = getattr(self, cache_key)
                if time.time() - cached_time < cache_duration:
                    logger.debug("📦 Using cached disbursement stats")
                    return cached_data

            logger.debug("🔍 Starting _get_total_disbursements_stats...")

            if not supabase_enabled:
                logger.warning("⚠️ Supabase not enabled, returning fallback data")
                fallback_breakdown = {
                    "Learn & Earn Rewards": "0.0 G$",
                    "Telegram Task Rewards": "0.0 G$",
                    "Twitter Task Rewards": "0.0 G$",
                    "Community Stories Rewards": "0.0 G$",
                    "Play & Earn Payouts": "0.0 G$",
                    "Forum Rewards Disbursed": "0.0 G$",
                    "Task Completion Rewards": "0.0 G$",
                    "NFT Card Sales (G$ OUT)": "0.0 G$",
                    "NFT Burn Rewards (G$ OUT)": "0.0 G$",
                    "Reloadly Store (G$ IN)": "0.0 G$",
                    "Daily Voucher Claims": "0 vouchers"
                }
                return {
                    "total_g_disbursed": 0,
                    "total_g_disbursed_formatted": "0.0 G$",
                    "learn_earn_total": 0,
                    "telegram_task_total": 0,
                    "twitter_task_total": 0,
                    "community_stories_total": 0,
                    "minigames_total": 0,
                    "forum_rewards_total": 0,
                    "task_completion_total": 0,
                        "reloadly_total": 0,
                    "nft_sales_total": 0,
                    "nft_burn_total": 0,
                    "daily_voucher_claims": 0,
                    "breakdown": {
                        "learn_earn": 0,
                        "telegram_task": 0,
                        "twitter_task": 0,
                        "community_stories": 0,
                        "minigames_withdrawals": 0,
                        "forum_disbursed": 0,
                        "task_completion": 0,
                        "reloadly_orders": 0,
                        "nft_sales": 0,
                        "nft_burns": 0,
                        "daily_voucher_claims": 0
                    },
                    "breakdown_formatted": fallback_breakdown,
                    "weekly_breakdown": {
                        "learn_earn": 0,
                        "telegram_task": 0,
                        "twitter_task": 0,
                        "community_stories": 0
                    },
                    "weekly_breakdown_formatted": {
                        "learn_earn": "0.0 G$",
                        "telegram_task": "0.0 G$",
                        "twitter_task": "0.0 G$",
                        "community_stories": "0.0 G$"
                    },
                    "weekly_date_range": {
                        "start_date": "N/A",
                        "end_date": "N/A"
                    },
                    "monthly_breakdown": {
                        "learn_earn": 0,
                        "telegram_task": 0,
                        "twitter_task": 0,
                        "community_stories": 0
                    },
                    "monthly_breakdown_formatted": {
                        "learn_earn": "0.0 G$",
                        "telegram_task": "0.0 G$",
                        "twitter_task": "0.0 G$",
                        "community_stories": "0.0 G$"
                    },
                    "monthly_date_range": {
                        "start_date": "N/A",
                        "end_date": "N/A"
                    }
                }

            # Calculate date range for disbursements
            end_date = datetime.utcnow()

            # Monthly: November 1 to current date
            start_date_monthly = datetime(2024, 11, 1)

            # Weekly: Last 7 days from current date
            start_date_weekly = end_date - timedelta(days=7)

            # Format with time to ensure we capture full day ranges
            start_date_weekly_str = start_date_weekly.strftime('%Y-%m-%d 00:00:00')
            start_date_monthly_str = start_date_monthly.strftime('%Y-%m-%d 00:00:00')
            end_date_str = end_date.strftime('%Y-%m-%d 23:59:59')

            # Initialize totals
            total_disbursements = 0
            breakdown = {}

            # Prefer the service-role client: these payout ledgers have RLS
            # enabled and the anon role can be denied SELECT, which used to make
            # a feature silently report 0 G$.
            disbursement_client = _disbursement_client()
            if disbursement_client is None:
                logger.warning("⚠️ No Supabase client available for disbursement stats")

            # Exactly-once rules. Each feature is summed from the ONE ledger that
            # records its payout:
            #   * Learn & Earn -> learnearn_log. The Superfluid stream ledger is a
            #     separate rail for the same reward, so it is NOT summed.
            #   * Daily tasks  -> *_task_log rows with status 'completed', which is
            #     set only after admin approval and the on-chain transfer. Pending
            #     and rejected submissions never paid anything.
            #   * Play & Earn  -> minigame_rewards_log (direct game payouts) plus
            #     minigame_withdrawals_log (balance withdrawals). The two ledgers
            #     are disjoint, so summing both counts each payout exactly once.
            # Reloadly is G$ IN (users paying the store): reported, never added.

            # 1. Learn & Earn disbursements (learnearn_log) - paid attempts only
            learn_earn_rows = _paginate_disbursement_rows(
                disbursement_client, 'learnearn_log',
                'amount_g$, status',
                filters=[('status', True)],
                order_columns=['timestamp', 'created_at'],
            )
            learn_earn_total = _sum_amount(learn_earn_rows, 'amount_g$')
            logger.debug(f"📊 Learn & Earn Query: {len(learn_earn_rows)} paid records")

            breakdown['learn_earn'] = learn_earn_total
            total_disbursements += learn_earn_total
            logger.debug(f"   Total: {learn_earn_total} G$")

            # 2. Forum rewards (forum_reward_transactions) - completed payouts only
            forum_rows = _paginate_optional_status(
                disbursement_client, 'forum_reward_transactions',
                'amount_disbursed, status',
                filters=[('status', 'completed')],
                order_columns=['created_at'],
            )
            forum_disbursed_total = _sum_amount(
                [row for row in forum_rows if _is_completed_payout(row)],
                'amount_disbursed',
            )
            breakdown['forum_disbursed'] = forum_disbursed_total
            total_disbursements += forum_disbursed_total
            logger.debug(f"   Total: {forum_disbursed_total} G$")

            # 3. Task completion disbursements (task_completion_log)
            task_rows = _paginate_optional_status(
                disbursement_client, 'task_completion_log',
                'reward_amount, status',
                filters=[('status', 'completed')],
                order_columns=['created_at', 'timestamp'],
            )
            task_completion_total = _sum_amount(
                [row for row in task_rows if _is_completed_payout(row)],
                'reward_amount',
            )
            breakdown['task_completion'] = task_completion_total
            total_disbursements += task_completion_total
            logger.debug(f"   Total: {task_completion_total} G$")

            # 4. Telegram Task disbursements (telegram_task_log) - approved only
            telegram_rows = _paginate_disbursement_rows(
                disbursement_client, 'telegram_task_log',
                'reward_amount, status',
                filters=[('status', 'completed')],
                order_columns=['created_at', 'id'],
            )
            telegram_task_total = _sum_amount(telegram_rows, 'reward_amount')
            logger.debug(
                f"📊 Telegram Task Query: {len(telegram_rows)} completed records"
            )

            breakdown['telegram_task'] = telegram_task_total
            total_disbursements += telegram_task_total
            logger.debug(f"   Total: {telegram_task_total} G$")

            # 4b. Twitter Task disbursements (twitter_task_log) - approved only
            twitter_rows = _paginate_disbursement_rows(
                disbursement_client, 'twitter_task_log',
                'reward_amount, status',
                filters=[('status', 'completed')],
                order_columns=['created_at', 'id'],
            )
            twitter_task_total = _sum_amount(twitter_rows, 'reward_amount')
            logger.debug(
                f"📊 Twitter Task Query: {len(twitter_rows)} completed records"
            )

            breakdown['twitter_task'] = twitter_task_total
            total_disbursements += twitter_task_total
            logger.debug(f"   Total: {twitter_task_total} G$")

            # 5. Play & Earn: direct game payouts + balance withdrawals.
            # This used to read minigame_rewards_log while filtering a
            # `reward_type` column that no writer in this codebase sets, so the
            # feature always reported 0 G$ no matter how much was paid out.
            # minigame_rewards_log has no status column — every row is written
            # only after a confirmed payout, so select just the amount.
            rewards_rows = _paginate_disbursement_rows(
                disbursement_client, 'minigame_rewards_log',
                'reward_amount',
                order_columns=['created_at'],
            )
            minigame_rewards_total = _sum_amount(rewards_rows, 'reward_amount')

            withdrawal_rows = _paginate_optional_status(
                disbursement_client, 'minigame_withdrawals_log',
                'amount, status',
                filters=[('status', 'completed')],
                order_columns=['withdrawal_date', 'created_at'],
            )
            minigame_withdrawals_total = _sum_amount(
                [row for row in withdrawal_rows if _is_completed_payout(row)],
                'amount',
            )

            minigames_total = minigame_rewards_total + minigame_withdrawals_total
            logger.debug(
                f"📊 Play & Earn: {len(rewards_rows)} game rewards "
                f"({minigame_rewards_total} G$) + {len(withdrawal_rows)} withdrawals "
                f"({minigame_withdrawals_total} G$)"
            )

            breakdown['minigames_withdrawals'] = minigames_total
            total_disbursements += minigames_total
            logger.debug(f"   Total: {minigames_total} G$")

            # 6. Community Stories disbursements (approved submissions only)
            community_rows = _paginate_disbursement_rows(
                disbursement_client, 'community_stories_submissions',
                'reward_amount, status, reviewed_at',
                filters=[('status', ('in', ['approved', 'approved_low', 'approved_high']))],
                order_columns=['reviewed_at', 'submitted_at', 'created_at'],
            )
            community_stories_total = _sum_amount(community_rows, 'reward_amount')
            logger.debug(
                f"📊 Community Stories Query: {len(community_rows)} approved records"
            )

            breakdown['community_stories'] = community_stories_total
            total_disbursements += community_stories_total
            logger.debug(f"   Total: {community_stories_total} G$")

            # 7. Reloadly orders (G$ received IN from users) - reported, not disbursed
            reloadly_rows = _paginate_disbursement_rows(
                disbursement_client, 'reloadly_orders',
                'gd_amount, status',
                filters=[('status', 'completed')],
                order_columns=['created_at'],
            )
            reloadly_total = _sum_amount(reloadly_rows, 'gd_amount')
            breakdown['reloadly_orders'] = reloadly_total
            logger.debug(f"   Reloadly Total (G$ IN): {reloadly_total} G$")

            # 8. Achievement Card Sales (G$ paid to sellers - G$ OUT)
            nft_rows = _paginate_disbursement_rows(
                disbursement_client, 'achievement_card_sales',
                'sell_price',
                order_columns=['created_at'],
            )
            nft_sales_total = _sum_amount(nft_rows, 'sell_price')
            breakdown['nft_sales'] = nft_sales_total
            total_disbursements += nft_sales_total
            logger.debug(f"   NFT Sales Total (G$ OUT): {nft_sales_total} G$")

            # 8b. NFT Burn Rewards (G$ disbursed to users who burn their NFTs)
            nft_burn_rows = _paginate_disbursement_rows(
                disbursement_client, 'nft_burn_history',
                'burn_amount_g',
                order_columns=['created_at', 'burned_at'],
            )
            nft_burn_total = _sum_amount(nft_burn_rows, 'burn_amount_g')
            breakdown['nft_burns'] = nft_burn_total
            total_disbursements += nft_burn_total
            logger.debug(f"   NFT Burn Rewards Total (G$ OUT): {nft_burn_total} G$")

            # 9. Daily Voucher claims count. Vouchers pay G$ out of the
            # OneTimePayments escrow (a separate rail), so this stays a claim
            # count and is deliberately NOT added to the disbursed total.
            voucher_rows = _paginate_disbursement_rows(
                disbursement_client, 'daily_voucher',
                'id, is_claimed',
                filters=[('is_claimed', True)],
                order_columns=['claimed_at', 'voucher_date'],
            )
            daily_voucher_claims = len(voucher_rows)
            breakdown['daily_voucher_claims'] = daily_voucher_claims
            logger.debug(f"   Daily Voucher Claims: {daily_voucher_claims}")

            # ---- Time-windowed breakdowns (same sources and status rules) ----
            weekly_learn_earn_rows = _paginate_disbursement_rows(
                disbursement_client, 'learnearn_log',
                'amount_g$, timestamp, status',
                filters=[
                    ('status', True),
                    ('timestamp', ('gte', start_date_weekly_str)),
                    ('timestamp', ('lte', end_date_str)),
                ],
                order_columns=['timestamp'],
            )
            weekly_learn_earn_total = _sum_amount(weekly_learn_earn_rows, 'amount_g$')

            weekly_telegram_rows = _paginate_disbursement_rows(
                disbursement_client, 'telegram_task_log',
                'reward_amount, created_at, status',
                filters=[
                    ('status', 'completed'),
                    ('created_at', ('gte', start_date_weekly_str)),
                    ('created_at', ('lte', end_date_str)),
                ],
                order_columns=['created_at', 'id'],
            )
            weekly_telegram_total = _sum_amount(weekly_telegram_rows, 'reward_amount')

            weekly_twitter_rows = _paginate_disbursement_rows(
                disbursement_client, 'twitter_task_log',
                'reward_amount, created_at, status',
                filters=[
                    ('status', 'completed'),
                    ('created_at', ('gte', start_date_weekly_str)),
                    ('created_at', ('lte', end_date_str)),
                ],
                order_columns=['created_at', 'id'],
            )
            weekly_twitter_total = _sum_amount(weekly_twitter_rows, 'reward_amount')

            weekly_community_rows = _paginate_disbursement_rows(
                disbursement_client, 'community_stories_submissions',
                'reward_amount, reviewed_at, status',
                filters=[
                    ('status', ('in', ['approved', 'approved_low', 'approved_high'])),
                    ('reviewed_at', ('gte', start_date_weekly_str)),
                    ('reviewed_at', ('lte', end_date_str)),
                ],
                order_columns=['reviewed_at', 'submitted_at', 'created_at'],
            )
            weekly_community_total = _sum_amount(weekly_community_rows, 'reward_amount')

            logger.info(f"📅 Weekly Learn & Earn: {weekly_learn_earn_total} G$")
            logger.info(f"📅 Weekly Telegram Task: {weekly_telegram_total} G$")
            logger.info(f"📅 Weekly Twitter Task: {weekly_twitter_total} G$")
            logger.info(f"📅 Weekly Community Stories: {weekly_community_total} G$")

            monthly_learn_earn_rows = _paginate_disbursement_rows(
                disbursement_client, 'learnearn_log',
                'amount_g$, timestamp, status',
                filters=[
                    ('status', True),
                    ('timestamp', ('gte', start_date_monthly_str)),
                    ('timestamp', ('lte', end_date_str)),
                ],
                order_columns=['timestamp'],
            )
            monthly_learn_earn_total = _sum_amount(monthly_learn_earn_rows, 'amount_g$')

            monthly_telegram_rows = _paginate_disbursement_rows(
                disbursement_client, 'telegram_task_log',
                'reward_amount, created_at, status',
                filters=[
                    ('status', 'completed'),
                    ('created_at', ('gte', start_date_monthly_str)),
                    ('created_at', ('lte', end_date_str)),
                ],
                order_columns=['created_at', 'id'],
            )
            monthly_telegram_total = _sum_amount(monthly_telegram_rows, 'reward_amount')

            monthly_twitter_rows = _paginate_disbursement_rows(
                disbursement_client, 'twitter_task_log',
                'reward_amount, created_at, status',
                filters=[
                    ('status', 'completed'),
                    ('created_at', ('gte', start_date_monthly_str)),
                    ('created_at', ('lte', end_date_str)),
                ],
                order_columns=['created_at', 'id'],
            )
            monthly_twitter_total = _sum_amount(monthly_twitter_rows, 'reward_amount')

            monthly_community_rows = _paginate_disbursement_rows(
                disbursement_client, 'community_stories_submissions',
                'reward_amount, reviewed_at, status',
                filters=[
                    ('status', ('in', ['approved', 'approved_low', 'approved_high'])),
                    ('reviewed_at', ('gte', start_date_monthly_str)),
                    ('reviewed_at', ('lte', end_date_str)),
                ],
                order_columns=['reviewed_at', 'submitted_at', 'created_at'],
            )
            monthly_community_total = _sum_amount(monthly_community_rows, 'reward_amount')

            logger.info(f"📅 Monthly Learn & Earn: {monthly_learn_earn_total} G$")
            logger.info(f"📅 Monthly Telegram Task: {monthly_telegram_total} G$")
            logger.info(f"📅 Monthly Twitter Task: {monthly_twitter_total} G$")
            logger.info(f"📅 Monthly Community Stories: {monthly_community_total} G$")
            # Format breakdown for display
            breakdown_formatted = {
                "Learn & Earn Rewards": f"{learn_earn_total:,.1f} G$",
                "Telegram Task Rewards": f"{telegram_task_total:,.1f} G$",
                "Twitter Task Rewards": f"{twitter_task_total:,.1f} G$",
                "Community Stories Rewards": f"{community_stories_total:,.1f} G$",
                "Play & Earn Payouts": f"{minigames_total:,.1f} G$",
                "Forum Rewards Disbursed": f"{forum_disbursed_total:,.1f} G$",
                "Task Completion Rewards": f"{task_completion_total:,.1f} G$",
                "NFT Card Sales (G$ OUT)": f"{nft_sales_total:,.1f} G$",
                "NFT Burn Rewards (G$ OUT)": f"{nft_burn_total:,.1f} G$",
                "Reloadly Store (G$ IN)": f"{reloadly_total:,.1f} G$",
                "Daily Voucher Claims": f"{daily_voucher_claims} vouchers"
            }

            logger.debug(f"📊 Breakdown formatted includes Community Stories: {community_stories_total:,.1f} G$")

            weekly_breakdown = {
                "learn_earn": weekly_learn_earn_total,
                "telegram_task": weekly_telegram_total,
                "twitter_task": weekly_twitter_total,
                "community_stories": weekly_community_total
            }

            weekly_breakdown_formatted = {
                "learn_earn": f"{weekly_learn_earn_total:,.1f} G$",
                "telegram_task": f"{weekly_telegram_total:,.1f} G$",
                "twitter_task": f"{weekly_twitter_total:,.1f} G$",
                "community_stories": f"{weekly_community_total:,.1f} G$"
            }

            weekly_date_range = {
                "start_date": start_date_weekly.strftime('%b %d, %Y'),  # Nov 04, 2025
                "end_date": end_date.strftime('%b %d, %Y')       # Nov 11, 2025
            }

            monthly_breakdown = {
                "learn_earn": monthly_learn_earn_total,
                "telegram_task": monthly_telegram_total,
                "twitter_task": monthly_twitter_total,
                "community_stories": monthly_community_total
            }

            monthly_breakdown_formatted = {
                "learn_earn": f"{monthly_learn_earn_total:,.1f} G$",
                "telegram_task": f"{monthly_telegram_total:,.1f} G$",
                "twitter_task": f"{monthly_twitter_total:,.1f} G$",
                "community_stories": f"{monthly_community_total:,.1f} G$"
            }

            monthly_date_range = {
                "start_date": start_date_monthly.strftime('%b %d, %Y'),  # Oct 12, 2025
                "end_date": end_date.strftime('%b %d, %Y')       # Nov 11, 2025
            }

            logger.debug(f"📊 Formatted breakdown: {breakdown_formatted}")

            logger.debug("📊 Total G$ Disbursements Analysis:")
            logger.debug(f"   Learn & Earn: {learn_earn_total:,.1f} G$")
            logger.debug(f"   Telegram Task: {telegram_task_total:,.1f} G$")
            logger.debug(f"   Twitter Task: {twitter_task_total:,.1f} G$")
            logger.debug(f"   Community Stories: {community_stories_total:,.1f} G$")
            logger.debug(f"   Play & Earn Payouts: {minigames_total:,.1f} G$")
            logger.debug(f"   Forum Disbursed: {forum_disbursed_total:,.1f} G$")
            logger.debug(f"   Task Completion: {task_completion_total:,.1f} G$")
            logger.debug(f"   TOTAL DISBURSED: {total_disbursements:,.1f} G$")

            logger.debug(f"✅ Returning disbursement data with {len(breakdown_formatted)} categories")
            logger.debug(f"🔍 breakdown_formatted type: {type(breakdown_formatted)}")
            logger.debug(f"🔍 breakdown_formatted content: {json.dumps(breakdown_formatted, indent=2)}")

            result = {
                'total_g_disbursed': total_disbursements,
                'total_g_disbursed_formatted': f"{total_disbursements:,.2f} G$",
                'learn_earn_total': learn_earn_total,
                'telegram_task_total': telegram_task_total,
                'twitter_task_total': twitter_task_total,
                'community_stories_total': community_stories_total,
                'minigames_total': minigames_total,
                'forum_rewards_total': forum_disbursed_total,
                'task_completion_total': task_completion_total,
                'reloadly_total': reloadly_total,
                'nft_sales_total': nft_sales_total,
                'nft_burn_total': nft_burn_total,
                'daily_voucher_claims': daily_voucher_claims,
                'breakdown': breakdown,
                'breakdown_formatted': breakdown_formatted,
                'weekly_breakdown': weekly_breakdown,
                'weekly_breakdown_formatted': weekly_breakdown_formatted,
                'weekly_date_range': weekly_date_range,
                'monthly_breakdown': monthly_breakdown,
                'monthly_breakdown_formatted': monthly_breakdown_formatted,
                'monthly_date_range': monthly_date_range
            }

            logger.debug(f"🔍 FINAL RESULT - breakdown_formatted in result: {'breakdown_formatted' in result}")
            logger.debug(f"🔍 FINAL RESULT keys: {list(result.keys())}")

            # Cache the result
            setattr(self, '_disbursement_stats_cache', (result, time.time()))

            return result

        except Exception as e:
            logger.error(f"❌ Error calculating total disbursements: {e}")
            import traceback
            logger.error(f"📊 Full error traceback: {traceback.format_exc()}")

            # Provide fallback data with proper structure - MUST include Task Completion
            fallback_breakdown = {
                "Learn & Earn Rewards": "0.0 G$",
                "Telegram Task Rewards": "0.0 G$",
                "Twitter Task Rewards": "0.0 G$",
                "Community Stories Rewards": "0.0 G$",
                "Play & Earn Payouts": "0.0 G$",
                "Forum Rewards Disbursed": "0.0 G$",
                "Task Completion Rewards": "0.0 G$",
                "NFT Card Sales (G$ OUT)": "0.0 G$",
                "NFT Burn Rewards (G$ OUT)": "0.0 G$",
                "Reloadly Store (G$ IN)": "0.0 G$",
                "Daily Voucher Claims": "0 vouchers"
            }
            logger.error(f"📊 Using fallback breakdown: {fallback_breakdown}")
            
            fallback_result = {
                "total_g_disbursed": 0,
                "total_g_disbursed_formatted": "0.0 G$",
                "learn_earn_total": 0,
                "telegram_task_total": 0,
                "twitter_task_total": 0,
                "community_stories_total": 0,
                "minigames_total": 0,
                "forum_rewards_total": 0,
                "task_completion_total": 0,
                "reloadly_total": 0,
                "nft_sales_total": 0,
                "nft_burn_total": 0,
                "daily_voucher_claims": 0,
                "breakdown": {
                    "learn_earn": 0,
                    "telegram_task": 0,
                    "twitter_task": 0,
                    "community_stories": 0,
                    "minigames_withdrawals": 0,
                    "forum_disbursed": 0,
                    "task_completion": 0,
                    "reloadly_orders": 0,
                    "nft_sales": 0,
                    "nft_burns": 0,
                    "daily_voucher_claims": 0
                },
                "breakdown_formatted": fallback_breakdown,
                "weekly_breakdown": {
                    "learn_earn": 0,
                    "telegram_task": 0,
                    "twitter_task": 0,
                    "community_stories": 0
                },
                "weekly_breakdown_formatted": {
                    "learn_earn": "0.0 G$",
                    "telegram_task": "0.0 G$",
                    "twitter_task": "0.0 G$",
                    "community_stories": "0.0 G$"
                },
                "weekly_date_range": {
                    "start_date": "N/A",
                    "end_date": "N/A"
                },
                "monthly_breakdown": {
                    "learn_earn": 0,
                    "telegram_task": 0,
                    "twitter_task": 0,
                    "community_stories": 0
                },
                "monthly_breakdown_formatted": {
                    "learn_earn": "0.0 G$",
                    "telegram_task": "0.0 G$",
                    "twitter_task": "0.0 G$",
                    "community_stories": "0.0 G$"
                },
                "monthly_date_range": {
                    "start_date": "N/A",
                    "end_date": "N/A"
                }
            }
            
            logger.error(f"📊 Returning complete fallback structure with {len(fallback_breakdown)} breakdown categories")
            return fallback_result

    def _get_user_feature_participation(self, wallet_address: str):
        """Get user's participation in Learn & Earn and Telegram Task - includes ALL historical claims"""
        cache_key = f"user_feature_participation_{wallet_address}"
        cached = self._get_cached(cache_key, ttl_seconds=300)
        if cached:
            return cached

        try:
            from supabase_client import supabase, supabase_enabled
            from learn_and_earn.learn_and_earn import quiz_manager

            if not supabase_enabled:
                return {"learn_earn_quizzes": 0, "telegram_task_claims": 0, "total_rewards": 0}

            # Mask wallet address for database lookup
            masked_address = quiz_manager.mask_wallet_address(wallet_address)

            # Get Learn & Earn data
            learn_earn_data = supabase.table('learnearn_log')\
                .select('*')\
                .eq('wallet_address', masked_address)\
                .eq('status', True)\
                .execute()

            # Get Telegram Task data
            telegram_task_data = supabase.table('telegram_task_log')\
                .select('*')\
                .eq('wallet_address', wallet_address)\
                .eq('status', 'completed')\
                .execute()

            # Calculate totals
            learn_earn_quizzes = len(learn_earn_data.data) if learn_earn_data.data else 0
            telegram_task_claims = len(telegram_task_data.data) if telegram_task_data.data else 0

            # Calculate total rewards from ALL historical logs
            learn_earn_rewards = sum(float(quiz.get('amount_g$', 0)) for quiz in learn_earn_data.data) if learn_earn_data.data else 0
            telegram_task_rewards = sum(float(task.get('reward_amount', 0)) for task in telegram_task_data.data) if telegram_task_data.data else 0
            total_rewards = learn_earn_rewards + telegram_task_rewards

            logger.info(f"📊 User Feature Participation for {masked_address}:")
            logger.info(f"   Learn & Earn Quizzes: {learn_earn_quizzes} (Total: {learn_earn_rewards} G$)")
            logger.info(f"   Telegram Task Claims: {telegram_task_claims} (Total: {telegram_task_rewards} G$)")
            logger.info(f"   Total Rewards: {total_rewards} G$")

            result = {
                "learn_earn_quizzes": learn_earn_quizzes,
                "telegram_task_claims": telegram_task_claims,
                "total_rewards": total_rewards
            }
            self._set_cache(cache_key, result)
            return result

        except Exception as e:
            logger.error(f"❌ Error getting user feature participation: {e}")
            return {"learn_earn_quizzes": 0, "telegram_task_claims": 0, "total_rewards": 0}

    def _get_timestamp(self):
        """Get current timestamp"""
        from datetime import datetime
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def _calculate_engagement_score(self, wallet_address: str):
        """Calculate user engagement score (0-100)"""
        if wallet_address not in self.user_sessions:
            return 0

        session = self.user_sessions[wallet_address]
        page_views = session.get("page_views", 0)

        # Simple engagement calculation
        score = min(100, page_views * 10 + 20)  # Base 20, +10 per page view
        return score

    def _calculate_avg_session_length(self):
        """Calculate average session length in minutes"""
        if not self.user_sessions:
            return 0

        # Mock calculation - in real app would calculate from login to last activity
        return "12 minutes"  # Placeholder

    def _get_contract_balance_info(self, wallet_address: str):
        """Get contract balance information for dashboard display"""
        try:
            # Import blockchain service from main
            from blockchain import get_gooddollar_balance

            balance_result = get_gooddollar_balance(wallet_address)

            return {
                "user_balance": balance_result.get("balance", 0),
                "user_balance_formatted": balance_result.get("balance_formatted", "0.00 G$"),
                "contract_address": balance_result.get("contract", ""),
                "success": balance_result.get("success", False)
            }

        except Exception as e:
            print(f"❌ Error getting contract balance info: {e}")
            return {
                "user_balance": 0,
                "user_balance_formatted": "Error loading",
                "contract_address": "",
                "success": False
            }

    def _calculate_success_rate(self):
        """Calculate verification success rate"""
        total_attempts = self.dashboard_metrics["successful_verifications"] + self.dashboard_metrics["failed_verifications"]
        if total_attempts == 0:
            return "N/A"

        success_rate = (self.dashboard_metrics["successful_verifications"] / total_attempts) * 100
        return f"{success_rate:.1f}%"

    def _get_platform_stats(self):
        """Get platform-level statistics for guest users."""
        # Get real platform statistics using get_global_analytics
        return self.get_global_analytics()

    def _get_gooddollar_info(self):
        """Get general GoodDollar information for guest users."""
        # Returns real GoodDollar insights
        return self.get_gooddollar_insights()


# Global analytics instance
analytics = AnalyticsService()
