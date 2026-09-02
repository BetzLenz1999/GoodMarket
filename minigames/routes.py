import logging
import os
import asyncio
import re
from datetime import date, datetime
from flask import Blueprint, request, jsonify, render_template, session, redirect
from .minigames_manager import minigames_manager, normalize_tx_hash
from maintenance_service import maintenance_service

logger = logging.getLogger(__name__)

minigames_bp = Blueprint('minigames', __name__, url_prefix='/minigames')


def _normalize_withdrawal_tx_hash(value) -> str:
    """Return a normalized Celo tx hash from a raw hash or explorer URL."""
    raw_value = str(value or '').strip()
    if not raw_value:
        return ''

    tx_hash_match = re.search(r'0x[a-fA-F0-9]{64}|(?<![a-fA-F0-9])[a-fA-F0-9]{64}(?![a-fA-F0-9])', raw_value)
    if not tx_hash_match:
        return ''

    return normalize_tx_hash(tx_hash_match.group(0))


def _parse_report_date(value, parameter_name):
    """Parse a strict UTC calendar date used by a public game report."""
    if not value or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError(f'{parameter_name} must use YYYY-MM-DD format')
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f'{parameter_name} must be a valid calendar date') from exc


@minigames_bp.route('/participants/<report_date>')
def minigames_participants_report(report_date):
    """Public, shareable Play & Earn participation report for a UTC range."""
    try:
        start_day = _parse_report_date(report_date, 'date')
        end_day = _parse_report_date(request.args.get('end_date', report_date), 'end_date')
    except ValueError:
        return redirect('/minigames/participants/' + date.today().isoformat())

    if end_day < start_day:
        return redirect('/minigames/participants/' + start_day.isoformat())

    return render_template(
        'minigames_participants_report.html',
        report_date=start_day.isoformat(),
        report_end_date=end_day.isoformat(),
    )


@minigames_bp.route('/api/participants')
def minigames_participants():
    """Return completed Play & Earn withdrawals for an inclusive date range."""
    try:
        start_day = _parse_report_date(request.args.get('start_date') or request.args.get('date') or datetime.utcnow().date().isoformat(), 'start_date')
        end_day = _parse_report_date(request.args.get('end_date') or start_day.isoformat(), 'end_date')
        if end_day < start_day:
            return jsonify({'success': False, 'participants': [], 'error': 'end_date must be on or after start_date'}), 400

        from supabase_client import get_supabase_client
        supabase = get_supabase_client()
        if not supabase:
            return jsonify({'success': False, 'participants': [], 'error': 'Database not available'}), 500

        # Play & Earn's user-facing history records actual payouts in
        # minigame_withdrawals_log. The older minigame_rewards_log is only for
        # direct game rewards and is not the withdrawal history shown to users.
        # withdrawal_date is a database DATE, so use both endpoints inclusively.
        rows, page_size, offset = [], 1000, 0
        while True:
            result = supabase.table('minigame_withdrawals_log')\
                .select('wallet_address, amount, tx_hash, withdrawal_date, session_id')\
                .gte('withdrawal_date', start_day.isoformat())\
                .lte('withdrawal_date', end_day.isoformat())\
                .order('withdrawal_date', desc=False)\
                .range(offset, offset + page_size - 1)\
                .execute()
            page = result.data or []
            rows.extend(page)
            if len(page) < page_size:
                break
            offset += page_size

        participants, total_withdrawn = [], 0.0
        for row in rows:
            wallet = row.get('wallet_address', '')
            amount = float(row.get('amount') or 0)
            tx_hash = _normalize_withdrawal_tx_hash(row.get('tx_hash'))
            # Withdrawal rows are created only after the on-chain payout is
            # successful. Still exclude legacy rows without a valid hash.
            if not tx_hash:
                continue
            total_withdrawn += amount
            participants.append({
                'wallet_address': wallet,
                'display_name': f'{wallet[:6]}...{wallet[-4:]}' if wallet else 'Unknown wallet',
                'withdrawal_amount': amount,
                'withdrawal_formatted': f'{amount:,.2f} G$',
                'transaction_hash': tx_hash,
                'timestamp': row.get('withdrawal_date'),
                'session_id': row.get('session_id') or '—',
            })

        return jsonify({
            'success': True,
            'participants': participants,
            'total_count': len(participants),
            'total_withdrawn': total_withdrawn,
            'total_withdrawn_formatted': f'{total_withdrawn:,.2f} G$',
            'start_date': start_day.isoformat(),
            'end_date': end_day.isoformat(),
        })
    except ValueError as exc:
        return jsonify({'success': False, 'participants': [], 'error': str(exc)}), 400
    except Exception as exc:
        logger.exception('Error getting minigame participants')
        return jsonify({'success': False, 'participants': [], 'error': 'Could not load minigame participants'}), 500


@minigames_bp.route('/')
def minigames_home():
    """Minigames dashboard"""
    wallet = session.get('wallet') or session.get('wallet_address')
    verified = session.get('verified') or session.get('ubi_verified')

    if not wallet or not verified:
        return redirect('/')

    # Human (face) verification gate — all login_methods must be
    # face-verified on the GoodDollar Identity contract to enter.
    from human_verification import human_verification_redirect
    fv_gate = human_verification_redirect(wallet)
    if fv_gate:
        return fv_gate

    # Check maintenance mode from database
    maintenance_status = maintenance_service.get_maintenance_status('minigames')
    if maintenance_status.get('is_maintenance', False):
        maintenance_message = maintenance_status.get('message', 'Minigames are temporarily under maintenance. Please check back later.')
        return render_template(
            'minigames.html', wallet=wallet, maintenance_mode=True,
            maintenance_message=maintenance_message,
            login_method=session.get('login_method', ''),
            walletconnect_project_id=os.environ.get('WALLETCONNECT_PROJECT_ID', ''),
            privy_app_id=os.environ.get('PRIVY_APP_ID', ''),
            privy_client_id=os.environ.get('PRIVY_CLIENT_ID', ''),
        )

    return render_template(
        'minigames.html', wallet=wallet, maintenance_mode=False,
        login_method=session.get('login_method', ''),
        walletconnect_project_id=os.environ.get('WALLETCONNECT_PROJECT_ID', ''),
        privy_app_id=os.environ.get('PRIVY_APP_ID', ''),
        privy_client_id=os.environ.get('PRIVY_CLIENT_ID', ''),
    )

@minigames_bp.route('/api/check-limit/<game_type>')
def check_game_limit(game_type):
    """Check if user can play a game"""
    # Check maintenance mode from database
    maintenance_status = maintenance_service.get_maintenance_status('minigames')
    if maintenance_status.get('is_maintenance', False):
        return jsonify({'error': maintenance_status.get('message', 'Minigames are temporarily under maintenance')}), 503

    try:
        wallet = session.get('wallet') or session.get('wallet_address')
        if not wallet or not (session.get('verified') or session.get('ubi_verified')):
            return jsonify({'error': 'Not authenticated'}), 401

        # Removed coin_flip game type check
        if game_type == 'coin_flip':
            return jsonify({'success': False, 'error': 'Coin flip game is not available'}), 404

        limit_check = minigames_manager.check_daily_limit(wallet, game_type)

        return jsonify({
            'success': True,
            'limit_check': limit_check
        })

    except Exception as e:
        logger.error(f"❌ Error checking game limit: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@minigames_bp.route('/api/start-game', methods=['POST'])
def start_game():
    """Start a new minigame session"""
    # Check maintenance mode from database
    maintenance_status = maintenance_service.get_maintenance_status('minigames')
    if maintenance_status.get('is_maintenance', False):
        return jsonify({'error': maintenance_status.get('message', 'Minigames are temporarily under maintenance')}), 503

    try:
        wallet_address = session.get('wallet_address') or session.get('wallet')
        if not wallet_address or not (session.get('verified') or session.get('ubi_verified')):
            return jsonify({'success': False, 'error': 'Not authenticated'}), 401

        data = request.json
        game_type = data.get('game_type')
        bet_amount = data.get('bet_amount', 0)

        if not game_type:
            return jsonify({'success': False, 'error': 'Game type required'}), 400

        # Removed coin_flip game type check
        if game_type == 'coin_flip':
            return jsonify({'success': False, 'error': 'Coin flip game is not available'}), 404

        result = minigames_manager.start_game_session(wallet_address, game_type, bet_amount)
        return jsonify(result)

    except Exception as e:
        logger.error(f"❌ Error starting game: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@minigames_bp.route('/api/complete-game', methods=['POST'])
def complete_game():
    """Complete a game session"""
    try:
        wallet = session.get('wallet') or session.get('wallet_address')
        if not wallet or not (session.get('verified') or session.get('ubi_verified')):
            return jsonify({'error': 'Not authenticated'}), 401

        data = request.get_json()
        session_id = data.get('session_id')
        score = data.get('score', 0)
        game_data = data.get('game_data', {})

        if not session_id:
            return jsonify({'success': False, 'error': 'Session ID required'}), 400

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            result = loop.run_until_complete(
                minigames_manager.complete_game_session(session_id, score, game_data)
            )
        finally:
            loop.close()

        return jsonify(result)

    except Exception as e:
        logger.error(f"❌ Error completing game: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@minigames_bp.route('/api/user-stats')
def get_user_stats():
    """Get user game statistics with total virtual tokens across all games"""
    try:
        wallet = session.get('wallet') or session.get('wallet_address')
        if not wallet or not (session.get('verified') or session.get('ubi_verified')):
            logger.warning("⚠️ Unauthenticated request to /api/user-stats")
            return jsonify({'success': False, 'error': 'Not authenticated'}), 401

        logger.info(f"📊 Getting user stats for {wallet[:8]}...")
        result = minigames_manager.get_user_stats(wallet)

        # Always ensure we have a valid response structure
        stats = result.get('stats', [])
        logger.info(f"📊 Retrieved {len(stats)} game stats for {wallet[:8]}...")

        total_tokens = sum(stat.get('virtual_tokens', 0) for stat in stats)

        logger.info(f"💰 Total tokens across all games for {wallet[:8]}...: {total_tokens}")

        # Log individual game tokens for debugging
        if stats:
            for stat in stats:
                game_type = stat.get('game_type', 'unknown')
                tokens = stat.get('virtual_tokens', 0)
                plays = stat.get('total_plays', 0)
                logger.info(f"   {game_type}: {tokens} tokens ({plays} plays)")
        else:
            logger.info(f"   No game stats found - user hasn't played any games yet")

        # Always return success with proper data structure
        response_data = {
            'success': True,
            'stats': stats,
            'total_virtual_tokens': total_tokens
        }

        logger.info(f"✅ Returning response: {response_data}")

        return jsonify(response_data)

    except Exception as e:
        logger.error(f"❌ Error getting user stats: {e}")
        import traceback
        logger.error(f"🔍 Traceback: {traceback.format_exc()}")
        # Return error with proper structure
        return jsonify({
            'success': False,
            'stats': [],
            'total_virtual_tokens': 0,
            'error': str(e)
        }), 500

@minigames_bp.route('/api/balance')
def get_balance():
    """Get user's Play & Earn balance"""
    try:
        wallet = session.get('wallet') or session.get('wallet_address')
        if not wallet or not session.get('verified'):
            return jsonify({'success': False, 'error': 'Not authenticated'}), 401

        result = minigames_manager.get_deposit_balance(wallet)
        min_withdrawal = minigames_manager.MIN_WITHDRAWAL
        available = result.get('available_balance', 0)
        return jsonify({
            'success': True,
            'available_balance': available,
            'total_withdrawn': result.get('total_withdrawn', 0),
            'min_withdrawal': min_withdrawal,
            'can_withdraw': available >= min_withdrawal
        })
    except Exception as e:
        logger.error(f"❌ Error getting balance: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@minigames_bp.route('/api/withdraw', methods=['POST'])
def withdraw():
    """Prepare a user-paid, signed contract withdrawal voucher."""
    try:
        wallet = session.get('wallet') or session.get('wallet_address')
        if not wallet or not session.get('verified'):
            return jsonify({'success': False, 'error': 'Not authenticated'}), 401

        return jsonify(minigames_manager.prepare_user_paid_withdrawal(wallet))
    except Exception as e:
        logger.error(f"❌ Error processing withdrawal: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@minigames_bp.route('/api/withdraw/confirm', methods=['POST'])
def confirm_withdrawal():
    """Confirm an on-chain player-paid (or relayed) withdrawal before DB commit."""
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet or not session.get('verified'):
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    data = request.get_json(silent=True) or {}
    if not data.get('session_id') or not _normalize_withdrawal_tx_hash(data.get('tx_hash')):
        return jsonify({'success': False, 'error': 'Valid session ID and transaction hash are required'}), 400
    return jsonify(minigames_manager.finalize_user_paid_withdrawal(wallet, data['session_id'], data['tx_hash'], data.get('submitted_by')))


@minigames_bp.route('/api/withdraw/relay', methods=['POST'])
def relay_withdrawal():
    """Gasless fallback, available only after verifying the player lacks CELO."""
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet or not session.get('verified'):
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    prepared = minigames_manager.prepare_user_paid_withdrawal(wallet)
    if not prepared.get('success'):
        return jsonify(prepared)
    try:
        service = minigames_manager.blockchain_service
        # Do not let a funded player spend the server's CELO merely by choosing
        # the fallback endpoint. The buffer covers the claim call conservatively.
        user_celo = service.w3.eth.get_balance(wallet)
        required_celo = int(service.w3.eth.gas_price * 250000)
        if user_celo >= required_celo:
            return jsonify({'success': False, 'error_type': 'user_has_gas', 'error': 'Your wallet has CELO. Please approve the wallet transaction to pay gas.'}), 400
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            relayed = loop.run_until_complete(service.relay_withdrawal_voucher(prepared['voucher']))
        finally:
            loop.close()
        if not relayed.get('success'):
            return jsonify(relayed)
        return jsonify(minigames_manager.finalize_user_paid_withdrawal(wallet, prepared['session_id'], relayed['tx_hash'], relayed.get('submitted_by')))
    except Exception as exc:
        logger.exception('Could not relay minigame withdrawal')
        return jsonify({'success': False, 'error': str(exc)}), 500


@minigames_bp.route('/api/withdrawal-history')
def withdrawal_history():
    """Get user's withdrawal transaction history"""
    try:
        wallet = session.get('wallet') or session.get('wallet_address')
        if not wallet or not session.get('verified'):
            return jsonify({'success': False, 'error': 'Not authenticated'}), 401

        from supabase_client import get_supabase_client
        sb = get_supabase_client()
        res = sb.table('minigame_withdrawals_log')\
            .select('*')\
            .eq('wallet_address', wallet)\
            .order('withdrawal_date', desc=True)\
            .limit(20)\
            .execute()

        withdrawals = []
        for withdrawal in res.data or []:
            withdrawal = dict(withdrawal)
            status = str(withdrawal.get('status') or 'completed').lower()
            tx_hash = (
                withdrawal.get('tx_hash')
                or withdrawal.get('transaction_hash')
                or ''
            )
            tx_hash = _normalize_withdrawal_tx_hash(tx_hash)

            # Withdrawal history must only show completed on-chain payouts. Old
            # rows without a status are treated as completed only when they have
            # a valid transaction hash; failed/pending rows stay hidden so users
            # do not see fake or reverted transactions as successful withdrawals.
            if status not in ('completed', 'success', 'successful') or not tx_hash:
                continue

            withdrawal['status'] = 'completed'
            withdrawal['tx_hash'] = tx_hash
            withdrawal['explorer_url'] = f'https://explorer.celo.org/mainnet/tx/{tx_hash}'
            withdrawals.append(withdrawal)

        return jsonify({'success': True, 'withdrawals': withdrawals})
    except Exception as e:
        logger.error(f"❌ Error fetching withdrawal history: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@minigames_bp.route('/api/quiz-questions')
def get_quiz_questions():
    """Get quiz questions"""
    try:
        wallet = session.get('wallet') or session.get('wallet_address')
        if not wallet or not (session.get('verified') or session.get('ubi_verified')):
            return jsonify({'error': 'Not authenticated'}), 401

        difficulty = request.args.get('difficulty')
        questions = minigames_manager.get_quiz_questions(difficulty)

        return jsonify({
            'success': True,
            'questions': questions
        })

    except Exception as e:
        logger.error(f"❌ Error getting quiz questions: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500
