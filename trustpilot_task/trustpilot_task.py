
import os
import logging
import re
import requests
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, Optional
from supabase_client import get_supabase_client, get_supabase_admin_client, safe_supabase_operation
from cache_utils import supabase_cache
from .blockchain import trustpilot_blockchain_service

logger = logging.getLogger(__name__)

# Telegram Bot API configuration for admin-action notifications.
# Imported lazily (not from telegram_bot) to avoid circular imports.
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}" if TELEGRAM_BOT_TOKEN else ""

# Trustpilot review URL regex pattern
# Matches: https://www.trustpilot.com/reviews/682187e9b3ac2f2c0586dbaf
TRUSTPILOT_REVIEW_URL_PATTERN = re.compile(
    r'^https?://(?:www\.)?trustpilot\.com/reviews/[a-zA-Z0-9]+(?:\?.*)?$',
    re.IGNORECASE
)

# Fixed reward amount for Trustpilot task
TRUSTPILOT_REWARD_AMOUNT = 1000.0  # 1000 G$ per approved review


class TrustpilotTaskService:
    """Service for handling Trustpilot review tasks with manual admin approval"""

    def __init__(self):
        self.supabase = get_supabase_client()
        self._db_cache = {}
        logger.info("⭐ Trustpilot Task Service initialized (Manual Approval Mode)")

    def validate_trustpilot_url(self, url: str) -> bool:
        """Validate if URL is a valid Trustpilot review URL"""
        if not url:
            return False
        url = url.strip()
        if not TRUSTPILOT_REVIEW_URL_PATTERN.match(url):
            logger.warning(f"Trustpilot URL validation failed: {url}")
            return False
        return True

    def mask_wallet(self, wallet: str) -> str:
        """Mask wallet address for logging"""
        if not wallet or len(wallet) < 10:
            return wallet
        return wallet[:6] + "..." + wallet[-4:]

    def _get_telegram_chat_id(self, wallet_address: str) -> Optional[str]:
        """Look up a user's Telegram chat id from their wallet address.

        Uses the service-role client so RLS does not block the reverse lookup.
        Returns the most recently seen chat_id for the wallet, or None.
        """
        if not wallet_address:
            return None
        wallet = wallet_address.lower().strip()
        supabase = get_supabase_admin_client() or self.supabase
        if not supabase:
            return None
        try:
            result = safe_supabase_operation(
                lambda: supabase.table('telegram_wallet_sessions')
                    .select('telegram_chat_id')
                    .eq('wallet_address', wallet)
                    .order('last_seen_at', desc=True)
                    .limit(1)
                    .execute(),
                fallback_result=None,
                operation_name="lookup telegram chat_id for trustpilot notification"
            )
            if result and result.data:
                return result.data[0].get('telegram_chat_id')
        except Exception as e:
            logger.warning(f"⚠️ Could not resolve Telegram chat_id for {self.mask_wallet(wallet)}: {e}")
        return None

    def _notify_user(self, chat_id: str, text: str) -> bool:
        """Best-effort push of a Telegram message to a user's chat.

        Never raises — notification failures must not break the admin
        approve/decline flow. Returns True on success, False otherwise.
        """
        if not chat_id or not TELEGRAM_API:
            return False
        payload = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
        }
        try:
            resp = requests.post(f"{TELEGRAM_API}/sendMessage", json=payload, timeout=10)
            if resp.ok:
                logger.info(f"📬 Trustpilot notification sent to chat {chat_id}")
                return True
            logger.warning(f"⚠️ Telegram notify failed ({resp.status_code}): {resp.text[:200]}")
        except Exception as e:
            logger.warning(f"⚠️ Telegram notify error: {e}")
        return False

    async def get_task_stats(self, wallet_address: str) -> Dict[str, Any]:
        """Get Trustpilot task status for a user"""
        try:
            wallet = wallet_address.lower().strip()

            # Check if user has already completed (approved) the task
            completed_result = None
            if self.supabase:
                completed_result = safe_supabase_operation(
                    lambda: self.supabase.table('trustpilot_task_log')
                        .select('id, status, review_url, created_at, approved_at')
                        .eq('wallet_address', wallet)
                        .eq('status', 'approved')
                        .limit(1)
                        .execute(),
                    fallback_result=None,
                    operation_name=f"check completed trustpilot for {self.mask_wallet(wallet)}"
                )

            has_completed = completed_result and completed_result.data and len(completed_result.data) > 0
            completed_record = completed_result.data[0] if has_completed else None

            # Get all submissions (for history)
            all_submissions = []
            total_earned = 0.0
            if self.supabase:
                all_result = safe_supabase_operation(
                    lambda: self.supabase.table('trustpilot_task_log')
                        .select('*')
                        .eq('wallet_address', wallet)
                        .order('created_at', desc=True)
                        .execute(),
                    fallback_result=None,
                    operation_name=f"get trustpilot submissions for {self.mask_wallet(wallet)}"
                )
                if all_result and all_result.data:
                    all_submissions = all_result.data
                    total_earned = sum(float(r.get('reward_amount', 0)) for r in all_submissions if r.get('status') == 'approved')

            return {
                'success': True,
                'has_completed': has_completed,
                'completed_record': completed_record,
                'total_earned': total_earned,
                'submissions': all_submissions,
                'task_available': not has_completed,  # Task available only if not completed
                'reward_amount': TRUSTPILOT_REWARD_AMOUNT
            }

        except Exception as e:
            logger.error(f"❌ Error getting Trustpilot task stats: {e}")
            return {
                'success': False,
                'error': str(e),
                'has_completed': False,
                'total_earned': 0,
                'task_available': True
            }

    def has_completed_task(self, wallet_address: str) -> bool:
        """Check if user has already COMPLETED (approved) the Trustpilot task - ONE TIME ONLY"""
        try:
            if not self.supabase:
                return False

            wallet = wallet_address.lower().strip()

            result = safe_supabase_operation(
                lambda: self.supabase.table('trustpilot_task_log')
                    .select('id')
                    .eq('wallet_address', wallet)
                    .eq('status', 'approved')  # Only count APPROVED submissions
                    .limit(1)
                    .execute(),
                fallback_result=None,
                operation_name=f"check completed trustpilot for {self.mask_wallet(wallet)}"
            )

            return bool(result and result.data)

        except Exception as e:
            logger.error(f"❌ Error checking completed task: {e}")
            return False

    async def submit_review(self, wallet_address: str, trustpilot_url: str) -> Dict[str, Any]:
        """
        Submit Trustpilot review URL for admin approval.
        This does NOT automatically disburse rewards - admin must approve first.
        """
        try:
            wallet = wallet_address.lower().strip()
            url = trustpilot_url.strip()

            logger.info(f"⭐ Processing Trustpilot submission for {self.mask_wallet(wallet)} | URL: {url}")

            # Check if already completed
            if self.has_completed_task(wallet):
                return {
                    'success': False,
                    'error': 'You have already completed this task',
                    'task_completed': True
                }

            # Validate URL
            if not self.validate_trustpilot_url(url):
                logger.warning(f"❌ Invalid Trustpilot URL: {url}")
                return {
                    'success': False,
                    'error': 'Invalid Trustpilot review URL. Please use format: https://www.trustpilot.com/reviews/682187e9b3ac2f2c0586dbaf'
                }

            # Check for duplicate submission (pending or approved)
            if self.supabase:
                existing = safe_supabase_operation(
                    lambda: self.supabase.table('trustpilot_task_log')
                        .select('id, status')
                        .eq('wallet_address', wallet)
                        .eq('review_url', url)
                        .limit(1)
                        .execute(),
                    fallback_result=None,
                    operation_name=f"check existing trustpilot for {self.mask_wallet(wallet)}"
                )
                if existing and existing.data:
                    existing_status = existing.data[0].get('status')
                    if existing_status == 'approved':
                        return {
                            'success': False,
                            'error': 'You have already completed this task',
                            'task_completed': True
                        }
                    elif existing_status == 'pending':
                        return {
                            'success': False,
                            'error': 'You already have a pending submission. Please wait for admin review.'
                        }
                    elif existing_status == 'declined':
                        # Allow re-submission if previously declined
                        safe_supabase_operation(
                            lambda: self.supabase.table('trustpilot_task_log')
                                .delete()
                                .eq('id', existing.data[0]['id'])
                                .execute(),
                            fallback_result=None,
                            operation_name=f"delete declined trustpilot for {self.mask_wallet(wallet)}"
                        )
                    else:
                        return {
                            'success': False,
                            'error': 'You have already submitted this review URL'
                        }

            # Submit for admin approval (status = pending)
            if self.supabase:
                safe_supabase_operation(
                    lambda: self.supabase.table('trustpilot_task_log')
                        .insert({
                            'wallet_address': wallet,
                            'review_url': url,
                            'reward_amount': TRUSTPILOT_REWARD_AMOUNT,
                            'status': 'pending',  # Pending admin approval
                            'created_at': datetime.now(timezone.utc).isoformat()
                        })
                        .execute(),
                    fallback_result=None,
                    operation_name=f"submit trustpilot task for {self.mask_wallet(wallet)}"
                )

            logger.info(f"✅ Trustpilot review submitted: {url} by {self.mask_wallet(wallet)} (awaiting admin approval)")

            return {
                'success': True,
                'message': '✅ Your Trustpilot review has been submitted for review. You will receive 1000 G$ once approved by admin.',
                'status': 'pending',
                'review_url': url,
                'reward_amount': TRUSTPILOT_REWARD_AMOUNT
            }

        except Exception as e:
            logger.error(f"❌ Error submitting Trustpilot review: {e}")
            import traceback
            logger.error(f"🔍 Traceback: {traceback.format_exc()}")
            return {
                'success': False,
                'error': f'Failed to submit review: {str(e)}'
            }

    def get_transaction_history(self, wallet_address: str, limit: int = 50) -> Dict[str, Any]:
        """Get Trustpilot task transaction history for a user"""
        try:
            wallet = wallet_address.lower().strip()

            if not self.supabase:
                return {
                    'success': False,
                    'error': 'Database not available',
                    'transactions': [],
                    'total_count': 0,
                    'total_earned': 0
                }

            result = safe_supabase_operation(
                lambda: self.supabase.table('trustpilot_task_log')
                    .select('*')
                    .eq('wallet_address', wallet)
                    .order('created_at', desc=True)
                    .limit(limit)
                    .execute(),
                fallback_result=None,
                operation_name=f"get trustpilot history for {self.mask_wallet(wallet)}"
            )

            transactions = result.data if result and result.data else []
            total_earned = sum(float(t.get('reward_amount', 0)) for t in transactions if t.get('status') == 'approved')

            logger.info(f"✅ Retrieved {len(transactions)} Trustpilot transactions for {self.mask_wallet(wallet)} (Total earned: {total_earned} G$)")

            return {
                'success': True,
                'transactions': transactions,
                'total_count': len(transactions),
                'total_earned': total_earned,
                'summary': {
                    'total_earned': total_earned,
                    'transaction_count': len(transactions),
                    'approved_count': len([t for t in transactions if t.get('status') == 'approved']),
                    'pending_count': len([t for t in transactions if t.get('status') == 'pending']),
                    'declined_count': len([t for t in transactions if t.get('status') == 'declined'])
                }
            }

        except Exception as e:
            logger.error(f"❌ Error getting Trustpilot task transaction history: {e}")
            return {
                'success': False,
                'error': str(e),
                'transactions': [],
                'total_count': 0,
                'total_earned': 0
            }

    def get_pending_submissions(self, limit: int = 100) -> Dict[str, Any]:
        """Get all pending Trustpilot review submissions for admin dashboard"""
        try:
            if not self.supabase:
                return {
                    'success': False,
                    'error': 'Database not available',
                    'submissions': [],
                    'total_count': 0
                }

            result = safe_supabase_operation(
                lambda: self.supabase.table('trustpilot_task_log')
                    .select('*')
                    .eq('status', 'pending')
                    .order('created_at', desc=True)
                    .limit(limit)
                    .execute(),
                fallback_result=None,
                operation_name="get pending trustpilot submissions"
            )

            submissions = result.data if result and result.data else []

            return {
                'success': True,
                'submissions': submissions,
                'total_count': len(submissions)
            }

        except Exception as e:
            logger.error(f"❌ Error getting pending submissions: {e}")
            return {
                'success': False,
                'error': str(e),
                'submissions': [],
                'total_count': 0
            }

    def get_admin_stats(self) -> Dict[str, Any]:
        """Get Trustpilot task statistics for admin dashboard"""
        try:
            if not self.supabase:
                return {
                    'success': False,
                    'error': 'Database not available',
                    'pending_count': 0,
                    'approved_count': 0,
                    'total_reward': 0
                }

            # Get pending count
            pending_result = safe_supabase_operation(
                lambda: self.supabase.table('trustpilot_task_log')
                    .select('id')
                    .eq('status', 'pending')
                    .execute(),
                fallback_result=None,
                operation_name="get pending trustpilot count"
            )
            pending_count = len(pending_result.data) if pending_result and pending_result.data else 0

            # Get approved count and total reward
            approved_result = safe_supabase_operation(
                lambda: self.supabase.table('trustpilot_task_log')
                    .select('reward_amount')
                    .eq('status', 'approved')
                    .execute(),
                fallback_result=None,
                operation_name="get approved trustpilot count"
            )
            approved_count = len(approved_result.data) if approved_result and approved_result.data else 0
            total_reward = sum(float(r.get('reward_amount', 0)) for r in (approved_result.data or []) if r.get('reward_amount'))

            return {
                'success': True,
                'pending_count': pending_count,
                'approved_count': approved_count,
                'total_reward': total_reward
            }

        except Exception as e:
            logger.error(f"❌ Error getting admin stats: {e}")
            return {
                'success': False,
                'error': str(e),
                'pending_count': 0,
                'approved_count': 0,
                'total_reward': 0
            }

    async def approve_submission(self, submission_id: str, admin_wallet: str) -> Dict[str, Any]:
        """Admin approves a Trustpilot submission - disburses 1000 G$ reward"""
        try:
            logger.info(f"⭐ Admin {self.mask_wallet(admin_wallet)} approving trustpilot submission: {submission_id}")

            if not self.supabase:
                return {'success': False, 'error': 'Database not available'}

            # Get the submission
            result = safe_supabase_operation(
                lambda: self.supabase.table('trustpilot_task_log')
                    .select('*')
                    .eq('id', submission_id)
                    .eq('status', 'pending')
                    .single()
                    .execute(),
                fallback_result=None,
                operation_name=f"get trustpilot submission {submission_id}"
            )

            if not result or not result.data:
                return {'success': False, 'error': 'Submission not found or already processed'}

            submission = result.data
            wallet_address = submission['wallet_address']
            reward_amount = float(submission.get('reward_amount', TRUSTPILOT_REWARD_AMOUNT))

            # Disburse reward
            task_id = f"trustpilot_{submission_id}"
            disbursement_result = await trustpilot_blockchain_service.disburse_trustpilot_reward(
                wallet_address=wallet_address,
                amount=reward_amount,
                task_id=task_id
            )

            if not disbursement_result.get('success'):
                error_msg = disbursement_result.get('error', 'Disbursement failed')
                logger.error(f"❌ Trustpilot reward disbursement failed: {error_msg}")
                return {
                    'success': False,
                    'error': f'Failed to disburse reward: {error_msg}',
                    'error_type': disbursement_result.get('error_type'),
                    'tx_hash': disbursement_result.get('tx_hash')
                }

            # Update status to approved
            safe_supabase_operation(
                lambda: self.supabase.table('trustpilot_task_log')
                    .update({
                        'status': 'approved',
                        'tx_hash': disbursement_result.get('tx_hash'),
                        'approved_by': admin_wallet,
                        'approved_at': datetime.now(timezone.utc).isoformat(),
                        'updated_at': datetime.now(timezone.utc).isoformat()
                    })
                    .eq('id', submission_id)
                    .execute(),
                fallback_result=None,
                operation_name=f"approve trustpilot {submission_id}"
            )

            logger.info(f"✅ Trustpilot submission approved: {reward_amount} G$ to {self.mask_wallet(wallet_address)}")

            # Best-effort Telegram notification to the user that their review was approved
            chat_id = self._get_telegram_chat_id(wallet_address)
            if chat_id:
                self._notify_user(
                    chat_id,
                    f"✅ <b>Trustpilot Review Approved!</b>\n\n"
                    f"Your Trustpilot review has been approved by the admin.\n"
                    f"Reward of <b>{reward_amount:.0f} G$</b> has been sent to your wallet.\n\n"
                    f"Wallet: <code>{self.mask_wallet(wallet_address)}</code>\n"
                    f"Thank you for sharing your experience! 🙌"
                )

            return {
                'success': True,
                'message': f'✅ Approved! {reward_amount} G$ disbursed to {self.mask_wallet(wallet_address)}',
                'reward_amount': reward_amount,
                'tx_hash': disbursement_result.get('tx_hash'),
                'explorer_url': disbursement_result.get('explorer_url'),
                'recipient': wallet_address,
                'notified': bool(chat_id)
            }

        except Exception as e:
            logger.error(f"❌ Error approving submission: {e}")
            import traceback
            logger.error(f"🔍 Traceback: {traceback.format_exc()}")
            return {'success': False, 'error': str(e)}

    def decline_submission(self, submission_id: str, admin_wallet: str, reason: str = None) -> Dict[str, Any]:
        """Admin declines a Trustpilot submission"""
        try:
            logger.info(f"⭐ Admin {self.mask_wallet(admin_wallet)} declining trustpilot submission: {submission_id}")

            if not self.supabase:
                return {'success': False, 'error': 'Database not available'}

            # Fetch the submission so we can notify the user afterwards
            submission_result = safe_supabase_operation(
                lambda: self.supabase.table('trustpilot_task_log')
                    .select('id, wallet_address, status')
                    .eq('id', submission_id)
                    .eq('status', 'pending')
                    .single()
                    .execute(),
                fallback_result=None,
                operation_name=f"get trustpilot submission for decline {submission_id}"
            )

            if not submission_result or not submission_result.data:
                return {'success': False, 'error': 'Submission not found or already processed'}

            wallet_address = submission_result.data.get('wallet_address')
            decline_reason = reason or 'No reason provided'

            # Update status to declined
            safe_supabase_operation(
                lambda: self.supabase.table('trustpilot_task_log')
                    .update({
                        'status': 'declined',
                        'declined_by': admin_wallet,
                        'declined_at': datetime.now(timezone.utc).isoformat(),
                        'decline_reason': decline_reason,
                        'updated_at': datetime.now(timezone.utc).isoformat()
                    })
                    .eq('id', submission_id)
                    .eq('status', 'pending')
                    .execute(),
                fallback_result=None,
                operation_name=f"decline trustpilot {submission_id}"
            )

            logger.info(f"✅ Trustpilot submission declined: {submission_id}")

            # Best-effort Telegram notification to the user that their review was declined
            notified = False
            if wallet_address:
                chat_id = self._get_telegram_chat_id(wallet_address)
                if chat_id:
                    notified = self._notify_user(
                        chat_id,
                        "❌ <b>Trustpilot Review Declined</b>\n\n"
                        "Your Trustpilot review submission was declined by the admin.\n"
                        f"📝 Reason: {decline_reason}\n\n"
                        "You may submit a new review URL using /trustpilot."
                    )

            return {
                'success': True,
                'message': 'Submission declined',
                'submission_id': submission_id,
                'notified': notified
            }

        except Exception as e:
            logger.error(f"❌ Error declining submission: {e}")
            return {'success': False, 'error': str(e)}

    def get_task_reward(self) -> float:
        """Return fixed reward amount for Trustpilot task"""
        return TRUSTPILOT_REWARD_AMOUNT


# Global instance
trustpilot_task_service = TrustpilotTaskService()


def init_trustpilot_task(app):
    """Initialize Trustpilot Task system with Flask app"""
    try:
        logger.info("⭐ Initializing Trustpilot Task system...")

        from flask import session, request, jsonify

        @app.route('/api/trustpilot-task/status', methods=['GET'])
        def get_trustpilot_task_status():
            """Get Trustpilot task status for current user"""
            try:
                wallet_address = session.get('wallet_address') or session.get('wallet')
                if not wallet_address or not session.get('verified'):
                    return jsonify({'error': 'Not authenticated'}), 401

                import asyncio
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    stats = loop.run_until_complete(
                        trustpilot_task_service.get_task_stats(wallet_address)
                    )
                finally:
                    loop.close()

                return jsonify(stats), 200

            except Exception as e:
                logger.error(f"❌ Trustpilot task status error: {e}")
                return jsonify({'error': 'Failed to get task status'}), 500

        @app.route('/api/trustpilot-task/submit', methods=['POST'])
        def submit_trustpilot_review():
            """Submit Trustpilot review URL for admin approval"""
            try:
                wallet_address = session.get('wallet_address') or session.get('wallet')
                if not wallet_address or not session.get('verified'):
                    return jsonify({'error': 'Not authenticated'}), 401

                data = request.get_json()
                trustpilot_url = data.get('trustpilot_url', '').strip()

                if not trustpilot_url:
                    return jsonify({
                        'success': False,
                        'error': 'Trustpilot review URL is required'
                    }), 400

                import asyncio

                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)

                try:
                    result = loop.run_until_complete(
                        trustpilot_task_service.submit_review(wallet_address, trustpilot_url)
                    )
                finally:
                    try:
                        loop.close()
                    except:
                        pass

                if result.get('success'):
                    return jsonify(result), 200
                else:
                    status_code = 400 if result.get('task_completed') else 400
                    return jsonify(result), status_code

            except Exception as e:
                logger.error(f"❌ Trustpilot task submit error: {e}")
                import traceback
                logger.error(f"🔍 Traceback: {traceback.format_exc()}")
                return jsonify({'error': 'Failed to submit review', 'details': str(e)}), 500

        @app.route('/api/trustpilot-task/history', methods=['GET'])
        def get_trustpilot_task_history():
            """Get Trustpilot task transaction history for current user"""
            try:
                wallet_address = session.get('wallet_address') or session.get('wallet')
                if not wallet_address or not session.get('verified'):
                    return jsonify({'error': 'Not authenticated'}), 401

                limit = int(request.args.get('limit', 50))

                history = trustpilot_task_service.get_transaction_history(wallet_address, limit)

                return jsonify(history), 200

            except Exception as e:
                logger.error(f"❌ Trustpilot task history error: {e}")
                return jsonify({
                    'success': False,
                    'error': 'Failed to get transaction history',
                    'transactions': [],
                    'total_count': 0
                }), 500

        @app.route('/trustpilot-task')
        def trustpilot_task_page():
            """Serve Trustpilot task page"""
            from flask import render_template
            return render_template('trustpilot_task.html')

        @app.route('/api/trustpilot-task/validate-url', methods=['POST'])
        def validate_trustpilot_url():
            """Validate a Trustpilot review URL"""
            try:
                data = request.get_json()
                url = data.get('url', '').strip()

                is_valid = trustpilot_task_service.validate_trustpilot_url(url)

                return jsonify({
                    'success': True,
                    'valid': is_valid,
                    'message': 'Valid Trustpilot review URL' if is_valid else 'Invalid Trustpilot review URL'
                }), 200

            except Exception as e:
                logger.error(f"❌ Trustpilot URL validation error: {e}")
                return jsonify({
                    'success': False,
                    'error': 'Failed to validate URL'
                }), 500

        # ============ ADMIN ENDPOINTS ============
        
        @app.route('/api/trustpilot-task/admin/pending', methods=['GET'])
        def get_trustpilot_pending():
            """Get all pending Trustpilot submissions for admin review"""
            try:
                wallet_address = session.get('wallet_address') or session.get('wallet')
                if not wallet_address or not session.get('verified'):
                    return jsonify({'error': 'Not authenticated'}), 401

                from supabase_client import is_admin
                if not is_admin(wallet_address):
                    return jsonify({'error': 'Admin access required'}), 403

                limit = int(request.args.get('limit', 100))
                result = trustpilot_task_service.get_pending_submissions(limit)
                return jsonify(result), 200

            except Exception as e:
                logger.error(f"❌ Trustpilot pending submissions error: {e}")
                return jsonify({'success': False, 'error': str(e)}), 500

        @app.route('/api/trustpilot-task/admin/stats', methods=['GET'])
        def get_trustpilot_stats():
            """Get Trustpilot task statistics for admin dashboard"""
            try:
                wallet_address = session.get('wallet_address') or session.get('wallet')
                if not wallet_address or not session.get('verified'):
                    return jsonify({'error': 'Not authenticated'}), 401

                from supabase_client import is_admin
                if not is_admin(wallet_address):
                    return jsonify({'error': 'Admin access required'}), 403

                result = trustpilot_task_service.get_admin_stats()
                return jsonify(result), 200

            except Exception as e:
                logger.error(f"❌ Trustpilot stats error: {e}")
                return jsonify({'success': False, 'error': str(e)}), 500

        @app.route('/api/trustpilot-task/admin/approve', methods=['POST'])
        def approve_trustpilot_submission():
            """Admin approves a Trustpilot submission - disburses 1000 G$"""
            try:
                wallet_address = session.get('wallet_address') or session.get('wallet')
                if not wallet_address or not session.get('verified'):
                    return jsonify({'error': 'Not authenticated'}), 401

                from supabase_client import is_admin
                if not is_admin(wallet_address):
                    return jsonify({'error': 'Admin access required'}), 403

                data = request.get_json()
                submission_id = data.get('submission_id', '').strip()

                if not submission_id:
                    return jsonify({'success': False, 'error': 'Submission ID is required'}), 400

                import asyncio
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)

                try:
                    result = loop.run_until_complete(
                        trustpilot_task_service.approve_submission(submission_id, wallet_address)
                    )
                finally:
                    try:
                        loop.close()
                    except:
                        pass

                if result.get('success'):
                    return jsonify(result), 200
                else:
                    return jsonify(result), 400

            except Exception as e:
                logger.error(f"❌ Trustpilot approval error: {e}")
                import traceback
                logger.error(f"🔍 Traceback: {traceback.format_exc()}")
                return jsonify({'success': False, 'error': str(e)}), 500

        @app.route('/api/trustpilot-task/admin/decline', methods=['POST'])
        def decline_trustpilot_submission():
            """Admin declines a Trustpilot submission"""
            try:
                wallet_address = session.get('wallet_address') or session.get('wallet')
                if not wallet_address or not session.get('verified'):
                    return jsonify({'error': 'Not authenticated'}), 401

                from supabase_client import is_admin
                if not is_admin(wallet_address):
                    return jsonify({'error': 'Admin access required'}), 403

                data = request.get_json()
                submission_id = data.get('submission_id', '').strip()
                reason = data.get('reason', '').strip()

                if not submission_id:
                    return jsonify({'success': False, 'error': 'Submission ID is required'}), 400

                result = trustpilot_task_service.decline_submission(submission_id, wallet_address, reason)

                if result.get('success'):
                    return jsonify(result), 200
                else:
                    return jsonify(result), 400

            except Exception as e:
                logger.error(f"❌ Trustpilot decline error: {e}")
                return jsonify({'success': False, 'error': str(e)}), 500

        logger.info("✅ Trustpilot Task system initialized successfully")
        return True

    except Exception as e:
        logger.error(f"❌ Failed to initialize Trustpilot Task system: {e}")
        return False
