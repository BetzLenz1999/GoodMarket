import logging
import uuid
import json
from datetime import datetime, timedelta, timezone
from supabase_client import get_supabase_client, safe_supabase_operation
from .blockchain import community_stories_blockchain
from config import COMMUNITY_STORIES_CONFIG
import asyncio

logger = logging.getLogger(__name__)

class CommunityStoriesService:
    def __init__(self):
        self.supabase = get_supabase_client()
        self.enabled = self.supabase is not None
        self.logger = logging.getLogger(__name__)
        self.logger.info("🌟 Community Stories Service initialized")

    def get_config(self):
        try:
            from supabase_client import get_supabase_client, safe_supabase_operation
            import json

            supabase = get_supabase_client()
            if not supabase:
                logger.warning("⚠️ Supabase not available, using hardcoded config")
                return COMMUNITY_STORIES_CONFIG

            # Try to get config from database
            result = safe_supabase_operation(
                lambda: supabase.table('maintenance_settings')\
                    .select('custom_message')\
                    .eq('feature_name', 'community_stories_config')\
                    .execute(),
                fallback_result=type('obj', (object,), {'data': []})(),
                operation_name="get community stories config from DB"
            )

            if result.data and len(result.data) > 0:
                try:
                    db_config = json.loads(result.data[0]['custom_message'])
                    # Merge with hardcoded config to ensure all fields exist
                    config = COMMUNITY_STORIES_CONFIG.copy()
                    config['LOW_REWARD'] = float(db_config.get('low_reward', config['LOW_REWARD']))
                    config['HIGH_REWARD'] = float(db_config.get('high_reward', config['HIGH_REWARD']))
                    config['REQUIRED_MENTIONS'] = db_config.get('required_mentions', config['REQUIRED_MENTIONS'])
                    config['WINDOW_START_DAY'] = int(db_config.get('window_start_day', config['WINDOW_START_DAY']))
                    config['WINDOW_END_DAY'] = int(db_config.get('window_end_day', config['WINDOW_END_DAY']))

                    logger.info(f"✅ Loaded Community Stories config from database: Window {config['WINDOW_START_DAY']}-{config['WINDOW_END_DAY']}, Rewards: {config['LOW_REWARD']}/{config['HIGH_REWARD']}")
                    return config
                except (json.JSONDecodeError, KeyError, ValueError) as e:
                    logger.error(f"❌ Error parsing config from database: {e}, using hardcoded")
                    return COMMUNITY_STORIES_CONFIG
            else:
                logger.info("ℹ️ No config in database, using hardcoded defaults")
                return COMMUNITY_STORIES_CONFIG

        except Exception as e:
            logger.error(f"❌ Error getting config from database: {e}, using hardcoded")
            return COMMUNITY_STORIES_CONFIG

    def is_participation_window_open(self) -> dict:
        """Check if current date is within participation window"""
        try:
            config = self.get_config()
            now = datetime.now(timezone.utc)
            current_day = now.day

            start_day = config['WINDOW_START_DAY']
            end_day = config['WINDOW_END_DAY']

            is_open = start_day <= current_day <= end_day

            # Calculate next window
            start_day = config['WINDOW_START_DAY']
            start_hour = COMMUNITY_STORIES_CONFIG['WINDOW_START_HOUR'] # Assuming these are not configurable via DB yet
            start_minute = COMMUNITY_STORIES_CONFIG['WINDOW_START_MINUTE'] # Assuming these are not configurable via DB yet

            if current_day < start_day:
                next_window = now.replace(day=start_day, hour=start_hour, minute=start_minute, second=0, microsecond=0)
            elif current_day > end_day:
                # Next month
                if now.month == 12:
                    next_window = now.replace(year=now.year+1, month=1, day=start_day, hour=start_hour, minute=start_minute, second=0, microsecond=0)
                else:
                    next_window = now.replace(month=now.month+1, day=start_day, hour=start_hour, minute=start_minute, second=0, microsecond=0)
            else:
                next_window = None

            return {
                'is_open': is_open,
                'current_day': current_day,
                'next_window': next_window.isoformat() if next_window else None
            }

        except Exception as e:
            logger.error(f"❌ Error checking participation window: {e}")
            return {'is_open': False, 'error': str(e)}


    def check_user_cooldown(self, wallet_address: str) -> dict:
        """Check if user already submitted during the current window (26th-30th of the month) - CACHED"""
        import time
        cache_key = f'cs_cooldown_{wallet_address}'
        if hasattr(self, '_cache'):
            if cache_key in self._cache:
                cached_data, cached_time = self._cache[cache_key]
                if time.time() - cached_time < 60:  # 60 seconds
                    logger.info(f"📦 Using cached Community Stories cooldown for {wallet_address[:8]}...")
                    return cached_data
        else:
            self._cache = {}

        if not self.enabled:
            return {'can_participate': False, 'error': 'Database not available'}

        try:
            config = self.get_config()
            window_start_day = config.get('WINDOW_START_DAY', 26)
            window_end_day = config.get('WINDOW_END_DAY', 30)

            now = datetime.utcnow()

            # Build the start and end timestamps of the current window
            window_start = now.replace(day=window_start_day, hour=0, minute=0, second=0, microsecond=0)
            window_end = now.replace(day=window_end_day, hour=23, minute=59, second=59, microsecond=999999)

            window_start_iso = window_start.isoformat()
            window_end_iso = window_end.isoformat()

            # Check if user has ANY submission (any status) during the current window
            existing = self.supabase.table('community_stories_submissions')\
                .select('submission_id, submitted_at, status')\
                .eq('wallet_address', wallet_address)\
                .gte('submitted_at', window_start_iso)\
                .lte('submitted_at', window_end_iso)\
                .limit(1)\
                .execute()

            if existing.data and len(existing.data) > 0:
                result = {
                    'can_participate': False,
                    'reason': 'already_submitted_this_window',
                    'existing_submission': existing.data[0],
                    'next_participation': self._get_next_month_window()
                }
                self._cache[cache_key] = (result, time.time())
                return result

            # No submission this window — user can participate
            result = {'can_participate': True}
            self._cache[cache_key] = (result, time.time())
            return result

        except Exception as e:
            logger.error(f"❌ Error checking cooldown: {e}")
            error_result = {'can_participate': False, 'error': str(e)}
            self._cache[cache_key] = (error_result, time.time())
            return error_result

    def _get_next_month_window(self) -> str:
        """Get next month's participation window using admin dashboard config."""
        now = datetime.utcnow()
        config = self.get_config()
        start_day = int(config.get('WINDOW_START_DAY', COMMUNITY_STORIES_CONFIG['WINDOW_START_DAY']))
        start_hour = COMMUNITY_STORIES_CONFIG['WINDOW_START_HOUR']
        start_minute = COMMUNITY_STORIES_CONFIG['WINDOW_START_MINUTE']

        if now.month == 12:
            next_month = now.replace(year=now.year+1, month=1, day=start_day, hour=start_hour, minute=start_minute, second=0)
        else:
            next_month = now.replace(month=now.month+1, day=start_day, hour=start_hour, minute=start_minute, second=0)
        return next_month.isoformat()

    def submit_screenshot(self, wallet_address: str, screenshot_url: str, submission_id: str) -> dict:
        """Submit screenshot for review (user submission)"""
        if not self.enabled:
            return {'success': False, 'error': 'Database not available'}

        try:
            from datetime import datetime

            # Create submission entry with screenshot
            submission = self.supabase.table('community_stories_submissions').insert({
                'submission_id': submission_id,
                'wallet_address': wallet_address,
                'tweet_url': '#',  # Placeholder since we have screenshot instead
                'status': 'pending',
                'storage_path': screenshot_url  # ImgBB URL
            }).execute()

            # Notify all admins
            self._notify_admins(submission_id)

            logger.info(f"✅ Screenshot submission created: {submission_id} for {wallet_address[:8]}...")

            return {
                'success': True,
                'submission_id': submission_id,
                'message': 'Screenshot submitted! Admin will review shortly.'
            }

        except Exception as e:
            logger.error(f"❌ Error submitting screenshot: {e}")
            return {'success': False, 'error': str(e)}

    def submit_tweet(self, wallet_address: str, tweet_url: str) -> dict:
        """Submit tweet URL for review - ONE SUBMISSION AT A TIME"""
        if not self.enabled:
            return {'success': False, 'error': 'Database not available'}

        try:
            # Check participation window
            window = self.is_participation_window_open()
            if not window['is_open']:
                return {
                    'success': False,
                    'error': 'Participation window closed',
                    'next_window': window['next_window']
                }

            # CRITICAL: Check if user already has a PENDING submission
            # Users can only submit ONCE - they must wait for approval/rejection
            pending_check = self.has_pending_submission(wallet_address)
            if pending_check.get('has_pending'):
                return {
                    'success': False,
                    'error': 'You already have a pending submission. Please wait for admin approval.',
                    'pending_submission': pending_check.get('pending_submission')
                }

            # Check if user already submitted during this window (26th-30th)
            cooldown = self.check_user_cooldown(wallet_address)
            if not cooldown.get('can_participate'):
                return {
                    'success': False,
                    'error': 'You already submitted during this window. You can participate again in the next window.',
                    'next_participation': cooldown.get('next_participation')
                }

            # Validate tweet URL
            config = self.get_config()
            required_mentions = config.get('REQUIRED_MENTIONS', [])
            if isinstance(required_mentions, str):
                required_mentions = [item for item in required_mentions.split() if item]
            if required_mentions:
                if not any(mention in tweet_url for mention in required_mentions):
                    return {
                        'success': False,
                        'error': f"Tweet must contain one of the required mentions: {', '.join(required_mentions)}"
                    }

            if not tweet_url.startswith('https://x.com/') and not tweet_url.startswith('https://twitter.com/'):
                return {
                    'success': False,
                    'error': 'Invalid Twitter/X URL format'
                }

            # Create submission
            submission_id = f"CS{uuid.uuid4().hex[:12].upper()}"

            submission = self.supabase.table('community_stories_submissions').insert({
                'submission_id': submission_id,
                'wallet_address': wallet_address,
                'tweet_url': tweet_url,
                'status': 'pending'
            }).execute()

            # Notify all admins
            self._notify_admins(submission_id)

            logger.info(f"✅ Submission created: {submission_id} for {wallet_address[:8]}...")

            return {
                'success': True,
                'submission_id': submission_id,
                'message': 'Submission received! Admin will review shortly.'
            }

        except Exception as e:
            logger.error(f"❌ Error submitting tweet: {e}")
            return {'success': False, 'error': str(e)}

    def _notify_admins(self, submission_id: str):
        """Create notifications for all admins"""
        try:
            # Get all admin wallets
            admins = self.supabase.table('user_data')\
                .select('wallet_address')\
                .eq('is_admin', True)\
                .execute()

            if admins.data:
                for admin in admins.data:
                    self.supabase.table('community_stories_admin_notifications').insert({
                        'submission_id': submission_id,
                        'admin_wallet': admin['wallet_address'],
                        'is_read': False
                    }).execute()

                logger.info(f"📬 Notified {len(admins.data)} admins about submission {submission_id}")
        except Exception as e:
            logger.error(f"❌ Error notifying admins: {e}")

    async def approve_submission(self, submission_id: str, reward_type: str, admin_wallet: str) -> dict:
        """Approve submission and disburse reward"""
        config = self.get_config()
        if not self.enabled:
            return {'success': False, 'error': 'Database not available'}

        try:
            # Get submission
            submission = self.supabase.table('community_stories_submissions')\
                .select('*')\
                .eq('submission_id', submission_id)\
                .execute()

            if not submission.data or len(submission.data) == 0:
                logger.error(f"❌ Submission {submission_id} not found")
                return {'success': False, 'error': 'Submission not found'}

            sub_data = submission.data[0]

            if sub_data['status'] != 'pending':
                logger.error(f"❌ Submission {submission_id} already processed: {sub_data['status']}")
                return {'success': False, 'error': 'Submission already processed'}

            # Determine reward amount based on type
            if reward_type == 'low':
                amount = config['LOW_REWARD']
                status = 'approved_low'
            elif reward_type == 'high':
                amount = config['HIGH_REWARD']
                status = 'approved_high'
            else:
                logger.error(f"❌ Invalid reward type: {reward_type}")
                return {'success': False, 'error': 'Invalid reward type'}

            wallet_address = sub_data['wallet_address']

            logger.info(f"💰 Approving submission {submission_id} for {wallet_address[:8]}... - {amount} G$ ({reward_type})")

            # Disburse reward
            result = await community_stories_blockchain.disburse_reward(
                wallet_address,
                amount,
                submission_id
            )

            if not result.get('success'):
                logger.error(f"❌ Blockchain disbursement failed: {result.get('error')}")
                return result

            # Update submission - use status that matches reward_type
            self.supabase.table('community_stories_submissions').update({
                'status': status,  # Use 'approved_low' or 'approved_high'
                'reward_amount': amount,
                'transaction_hash': result['tx_hash'],
                'reviewed_at': datetime.utcnow().isoformat(),
                'reviewed_by': admin_wallet
            }).eq('submission_id', submission_id).execute()

            # Update cooldown
            current_month = datetime.utcnow().strftime('%Y-%m')

            existing_cooldown = self.supabase.table('community_stories_cooldowns')\
                .select('*')\
                .eq('wallet_address', wallet_address)\
                .execute()

            if existing_cooldown.data:
                old_total = float(existing_cooldown.data[0].get('total_earned', 0))
                old_submissions = int(existing_cooldown.data[0].get('total_submissions', 0))

                self.supabase.table('community_stories_cooldowns').update({
                    'last_reward_month': current_month,
                    'last_reward_amount': amount,
                    'last_reward_date': datetime.utcnow().isoformat(),
                    'total_earned': old_total + amount,
                    'total_submissions': old_submissions + 1
                }).eq('wallet_address', wallet_address).execute()
            else:
                self.supabase.table('community_stories_cooldowns').insert({
                    'wallet_address': wallet_address,
                    'last_reward_month': current_month,
                    'last_reward_amount': amount,
                    'last_reward_date': datetime.utcnow().isoformat(),
                    'total_earned': amount,
                    'total_submissions': 1
                }).execute()

            # Mark notification as read
            self.supabase.table('community_stories_admin_notifications').update({
                'is_read': True
            }).eq('submission_id', submission_id).eq('admin_wallet', admin_wallet).execute()

            logger.info(f"✅ Approved submission {submission_id}: {amount} G$ to {wallet_address[:8]}...")

            return {
                'success': True,
                'amount': amount,
                'tx_hash': result['tx_hash'],
                'explorer_url': result['explorer_url']
            }

        except Exception as e:
            logger.error(f"❌ Error approving submission: {e}")
            return {'success': False, 'error': str(e)}

    def reject_submission(self, submission_id: str, admin_wallet: str, reason: str = None) -> dict:
        """Reject submission"""
        if not self.enabled:
            return {'success': False, 'error': 'Database not available'}

        try:
            # Update submission
            self.supabase.table('community_stories_submissions').update({
                'status': 'rejected',
                'reviewed_at': datetime.utcnow().isoformat(),
                'reviewed_by': admin_wallet,
                'admin_comment': reason
            }).eq('submission_id', submission_id).execute()

            # Mark notification as read
            self.supabase.table('community_stories_admin_notifications').update({
                'is_read': True
            }).eq('submission_id', submission_id).eq('admin_wallet', admin_wallet).execute()

            logger.info(f"❌ Rejected submission {submission_id}")

            return {'success': True, 'message': 'Submission rejected'}

        except Exception as e:
            logger.error(f"❌ Error rejecting submission: {e}")
            return {'success': False, 'error': str(e)}

    def get_admin_notifications(self, admin_wallet: str) -> dict:
        """Get pending submissions for admin"""
        if not self.enabled:
            return {'success': False, 'error': 'Database not available'}

        try:
            notifications = self.supabase.table('community_stories_admin_notifications')\
                .select('*, community_stories_submissions(*)')\
                .eq('admin_wallet', admin_wallet)\
                .eq('is_read', False)\
                .order('created_at', desc=True)\
                .execute()

            # Filter to only include submissions that are still pending
            filtered_notifications = [
                n for n in (notifications.data or [])
                if n.get('community_stories_submissions', {}).get('status') == 'pending'
            ]

            return {
                'success': True,
                'notifications': filtered_notifications,
                'count': len(filtered_notifications)
            }

        except Exception as e:
            logger.error(f"❌ Error getting admin notifications: {e}")
            return {'success': False, 'error': str(e)}

    def has_pending_submission(self, wallet_address: str) -> dict:
        """Check if user has pending submission"""
        if not self.enabled:
            return {'success': False, 'error': 'Database not available', 'has_pending': False}

        try:
            pending = self.supabase.table('community_stories_submissions')\
                .select('submission_id, submitted_at, tweet_url')\
                .eq('wallet_address', wallet_address)\
                .eq('status', 'pending')\
                .order('submitted_at', desc=True)\
                .limit(1)\
                .execute()

            if pending.data and len(pending.data) > 0:
                return {
                    'success': True,
                    'has_pending': True,
                    'pending_submission': pending.data[0]
                }
            else:
                return {
                    'success': True,
                    'has_pending': False
                }

        except Exception as e:
            logger.error(f"❌ Error checking pending submission: {e}")
            return {'success': False, 'error': str(e), 'has_pending': False}

    def get_user_submissions(self, wallet_address: str) -> dict:
        """Get user's submission history"""
        if not self.enabled:
            return {'success': False, 'error': 'Database not available'}

        try:
            submissions = self.supabase.table('community_stories_submissions')\
                .select('*')\
                .eq('wallet_address', wallet_address)\
                .order('submitted_at', desc=True)\
                .execute()

            cooldown = self.supabase.table('community_stories_cooldowns')\
                .select('*')\
                .eq('wallet_address', wallet_address)\
                .execute()

            return {
                'success': True,
                'submissions': submissions.data or [],
                'stats': cooldown.data[0] if cooldown.data else None
            }

        except Exception as e:
            logger.error(f"❌ Error getting user submissions: {e}")
            return {'success': False, 'error': str(e)}

    def get_submission_history(self, limit: int = 50) -> dict:
        """Get processed submissions history (for admin)"""
        if not self.enabled:
            return {'success': False, 'error': 'Database not available'}

        try:
            # Get all submissions that are NOT pending (approved or rejected)
            history = self.supabase.table('community_stories_submissions')\
                .select('*')\
                .neq('status', 'pending')\
                .order('reviewed_at', desc=True)\
                .limit(limit)\
                .execute()

            return {
                'success': True,
                'history': history.data or [],
                'count': len(history.data) if history.data else 0
            }

        except Exception as e:
            logger.error(f"❌ Error getting submission history: {e}")
            return {'success': False, 'error': str(e)}

    def add_screenshot(self, submission_id: str, screenshot_path: str) -> dict:
        """Add screenshot to approved submission"""
        if not self.enabled:
            return {'success': False, 'error': 'Database not available'}

        try:
            # Update submission with screenshot (ImgBB URL)
            self.supabase.table('community_stories_submissions').update({
                'storage_path': screenshot_path
            }).eq('submission_id', submission_id).execute()

            logger.info(f"✅ Added screenshot to submission {submission_id}")

            return {'success': True, 'screenshot_path': screenshot_path}

        except Exception as e:
            logger.error(f"❌ Error adding screenshot: {e}")
            return {'success': False, 'error': str(e)}

    def create_screenshot_entry(self, wallet_address: str, screenshot_path: str, submission_id: str) -> dict:
        """Create a screenshot entry directly (for admin uploads)"""
        if not self.enabled:
            return {'success': False, 'error': 'Database not available'}

        try:
            from datetime import datetime

            # Create submission entry with screenshot (ImgBB URL stored in storage_path)
            submission = self.supabase.table('community_stories_submissions').insert({
                'submission_id': submission_id,
                'wallet_address': wallet_address,
                'tweet_url': '#',  # Placeholder since this is direct upload
                'status': 'approved',
                'storage_path': screenshot_path,  # ImgBB URL
                'reward_amount': 0,  # No reward for direct upload
                'reviewed_at': datetime.utcnow().isoformat(),
                'reviewed_by': 'admin_direct_upload'
            }).execute()

            logger.info(f"✅ Created screenshot entry {submission_id} for {wallet_address[:8]}...")

            return {
                'success': True,
                'screenshot_path': screenshot_path,
                'submission_id': submission_id
            }

        except Exception as e:
            logger.error(f"❌ Error creating screenshot entry: {e}")
            return {'success': False, 'error': str(e)}

    def get_screenshots_for_homepage(self, limit: int = 12) -> dict:
        """Get approved submissions with screenshots for homepage display"""
        if not self.enabled:
            return {'success': False, 'error': 'Database not available'}

        try:
            # Get approved submissions that have screenshots (storage_path contains ImgBB URL)
            screenshots = self.supabase.table('community_stories_submissions')\
                .select('submission_id, wallet_address, tweet_url, storage_path, reviewed_at, reward_amount, status')\
                .in_('status', ['approved', 'approved_low', 'approved_high'])\
                .not_.is_('storage_path', 'null')\
                .order('reviewed_at', desc=True)\
                .limit(limit)\
                .execute()

            # Map storage_path to screenshot_url for frontend compatibility
            if screenshots.data:
                for screenshot in screenshots.data:
                    if screenshot.get('storage_path'):
                        screenshot['screenshot_url'] = screenshot['storage_path']

            return {
                'success': True,
                'screenshots': screenshots.data or [],
                'count': len(screenshots.data) if screenshots.data else 0
            }

        except Exception as e:
            logger.error(f"❌ Error getting screenshots: {e}")
            return {'success': False, 'error': str(e)}

    def get_screenshot_carousel(self):
        """Get approved screenshots for homepage carousel (ImgBB URLs)"""
        try:
            from supabase_client import supabase

            if not supabase:
                logger.error("❌ Supabase not available")
                return {'success': False, 'screenshots': []}

            # Get approved screenshots with storage_path (now contains ImgBB URLs)
            result = supabase.table('community_stories_submissions')\
                .select('submission_id, storage_path, wallet_address, created_at')\
                .in_('status', ['approved', 'approved_low', 'approved_high'])\
                .not_.is_('storage_path', 'null')\
                .order('created_at', desc=True)\
                .limit(20)\
                .execute()

            screenshots = []
            for item in result.data:
                # storage_path now contains the ImgBB URL directly
                screenshots.append({
                    'submission_id': item['submission_id'],
                    'screenshot_url': item['storage_path'],  # ImgBB URL
                    'wallet_address': item['wallet_address'],
                    'created_at': item['created_at']
                })

            logger.info(f"✅ Retrieved {len(screenshots)} screenshots for carousel")

            return {
                'success': True,
                'screenshots': screenshots
            }

        except Exception as e:
            logger.error(f"❌ Error getting screenshot carousel: {e}")
            return {'success': False, 'screenshots': []}

# Global instance
community_stories_service = CommunityStoriesService()
