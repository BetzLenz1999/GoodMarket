"""Daily Lotto (6/100) — HTTP routes.

Blueprint ``lotto`` at ``/lotto``. Follows the Flywheel feature-module
conventions (jumble/price_prediction): session + face-verification gated page,
JSON API for picks/draw/history/withdraws, and an admin sub-namespace for the
editable prize tiers / settings / manual draw / fund-vault quick action.
"""

from __future__ import annotations

import logging
import os
from decimal import Decimal

from flask import Blueprint, jsonify, render_template, request, redirect, session

from maintenance_service import maintenance_service
from . import service as svc
from .blockchain import lotto_blockchain

logger = logging.getLogger(__name__)

lotto_bp = Blueprint('daily_lotto', __name__, url_prefix='/lotto')


# ── Page ──────────────────────────────────────────────────────────────────────

@lotto_bp.route('/')
def lotto_home():
    wallet = session.get('wallet') or session.get('wallet_address')
    verified = session.get('verified') or session.get('ubi_verified')

    if not wallet or not verified:
        return redirect('/')

    # Human (face) verification gate — same as every earning page.
    from human_verification import human_verification_redirect
    fv_gate = human_verification_redirect(wallet)
    if fv_gate:
        return fv_gate

    maintenance = maintenance_service.get_maintenance_status('minigames')
    if maintenance.get('is_maintenance', False):
        return redirect('/minigames/')

    contract_address = os.environ.get('GOODMARKET_LOTTO_CONTRACT', '').strip()
    return render_template(
        'lotto.html',
        wallet=wallet,
        login_method=session.get('login_method', ''),
        walletconnect_project_id=os.environ.get('WALLETCONNECT_PROJECT_ID', ''),
        lotto_contract_address=contract_address,
    )


def _session_wallet() -> str | None:
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet or not (session.get('verified') or session.get('ubi_verified')):
        return None
    return wallet


# ── Public API ────────────────────────────────────────────────────────────────

@lotto_bp.route('/api/state')
def api_state():
    """Page state: round info, countdown, my pick, last drawn numbers, my
    winnings + vault status."""
    wallet = _session_wallet()
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401

    meta = svc.current_round_metadata()
    round_id = meta['round_id']
    svc.ensure_round_exists(round_id, meta['game_date'])

    entry = svc.get_entry(round_id, wallet)
    winnings = svc.get_my_winnings(wallet, limit=20)

    # Last completed round (for "last result" + match-checking).
    last_round = svc.get_round(round_id - 1) if round_id > 1 else None
    if not (last_round and last_round.get('winning_numbers')):
        last_round = None

    contract_balance = lotto_blockchain.get_contract_balance()

    vault_low = False
    pending_total = sum(
        (Decimal(str(w.get('amount_gd') or 0)) for w in winnings if w.get('status') == 'pending'),
        Decimal('0'),
    )
    if contract_balance is None:
        vault_low = True
    elif pending_total > 0 and contract_balance < pending_total:
        vault_low = True

    return jsonify({
        'success': True,
        'meta': meta,
        'pick': entry,
        'entries_this_round': svc.get_round_participant_count(round_id),
        'last_round': last_round and {
            'round_id': last_round['id'],
            'game_date': last_round.get('game_date'),
            'winning_numbers': last_round.get('winning_numbers'),
        },
        'winnings': winnings,
        'tiers': {str(k): str(v) for k, v in svc.get_prize_tiers().items()},
        'vault_balance': str(contract_balance) if contract_balance is not None else None,
        'vault_low': vault_low,
        'can_pick': not meta['drawn'],
        'login_method': session.get('login_method', ''),
    })


@lotto_bp.route('/api/pick', methods=['POST'])
def pick():
    wallet = _session_wallet()
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401

    data = request.json or {}
    raw_numbers = data.get('numbers')
    ok, error, numbers = svc.validate_pick(raw_numbers)
    if not ok:
        return jsonify({'success': False, 'error': error}), 400

    meta = svc.current_round_metadata()
    if meta['drawn']:
        return jsonify({'success': False, 'error': "Today's draw has already completed. Come back tomorrow!"}), 400

    # Proof of wallet ownership — the user must sign the exact message that
    # binds their wallet + round + numbers. Without a valid signature the pick
    # is rejected (a session cookie alone is not ownership proof).
    message = data.get('message')
    signature = data.get('signature')
    if not message or not signature:
        return jsonify({
            'success': False,
            'error': 'A wallet signature is required to submit your pick.',
            'error_type': 'signature_required',
        }), 400
    if not svc.verify_pick_signature(message, signature, wallet, meta['round_id'], numbers):
        return jsonify({
            'success': False,
            'error': 'Signature verification failed — please sign with your GoodMarket wallet.',
            'error_type': 'signature_invalid',
        }), 400

    svc.ensure_round_exists(meta['round_id'], meta['game_date'])
    result = svc.upsert_entry(meta['round_id'], wallet, numbers, signature=signature, signed_message=message)
    if result.get('success'):
        return jsonify({'success': True, 'numbers': numbers, 'round_id': meta['round_id']})
    code = 409 if result.get('already_picked') else 400
    return jsonify(result), code


@lotto_bp.route('/api/history')
def history():
    wallet = _session_wallet()
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    return jsonify({'success': True, 'rows': svc.get_my_history(wallet, limit=20)})


@lotto_bp.route('/api/participants')
def participants():
    """Public per-round participants feed: truncated wallets + their picked
    numbers + the total participant count for the day. Mirrors the Price
    Prediction live feed so users can see who is in today's draw and which
    balls they chose (wallets stay truncated server-side)."""
    wallet = _session_wallet()
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401

    meta = svc.current_round_metadata()
    round_id = meta['round_id']
    try:
        rid = int(request.args.get('round_id') or round_id)
    except (TypeError, ValueError):
        return jsonify({'success': False, 'error': 'Invalid round_id.'}), 400

    try:
        limit = max(1, min(int(request.args.get('limit') or 60), 200))
    except (TypeError, ValueError):
        limit = 60

    result = svc.get_round_participants(rid, wallet=wallet, limit=limit)
    result['current_round_id'] = round_id
    return jsonify(result)


# ── Withdraw ──────────────────────────────────────────────────────────────────

@lotto_bp.route('/api/withdraw', methods=['POST'])
def withdraw():
    """Preflight + 'magic withdraw' claim. Winners pull their own prize, paying
    their own CELO gas. When the vault is empty we tell the user to wait and
    alert the proposer/admin."""
    wallet = _session_wallet()
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401

    try:
        winnings = svc.get_my_winnings(wallet, limit=20)
        pending = [w for w in winnings if w.get('status') == 'pending']
        if not pending:
            return jsonify({'success': False, 'error': 'You have no pending winnings to withdraw.'}), 400

        # Check each pending win with a read-only eth_call — if the vault lacks
        # G$ the call reverts and we never make the user sign (or pay gas).
        all_claimable = True
        not_granted = False
        for win in pending:
            preflight = lotto_blockchain.preflight_claim(int(win['round_id']), wallet)
            if preflight.get('reason') == 'already_claimed':
                # The on-chain state is ahead of the DB (e.g. a previous
                # claim tx confirmed after we lost track) — mark it claimed.
                from supabase_client import get_supabase_admin_client
                sb = get_supabase_admin_client()
                sb.table('daily_lotto_winnings').update({
                    'status': 'claimed',
                    'claimed_at': svc._now_utc_iso(),
                }).eq('id', win['id']).execute()
                continue
            if not preflight.get('claimable'):
                all_claimable = False
                if preflight.get('reason') == 'no_reward':
                    # Round drew but the on-chain grant hasn't landed yet (the
                    # scheduler grants within a minute of 8PM). Not a vault
                    # problem — just come back shortly.
                    not_granted = True
                break

        pending = [w for w in svc.get_my_winnings(wallet, limit=20) if w.get('status') == 'pending']
        if not pending:
            return jsonify({'success': True, 'auto_synced': True, 'message': 'All winnings already claimed.'})

        if not all_claimable:
            if not_granted:
                return jsonify({
                    'success': False,
                    'error_type': 'not_granted_yet',
                    'message': (
                        'Your prize is being processed. Please check back in a '
                        'few minutes — no action needed.'
                    ),
                }), 409
            # Vault empty/insufficient → park + notify (throttled).
            svc.raise_vault_alert(
                round_id=int(pending[0]['round_id']),
                winners=len(pending),
                shortfall_gd=None,
            )
            return jsonify({
                'success': False,
                'error_type': 'insufficient_vault',
                'message': (
                    'The prize vault is being refilled. Please wait at least a '
                    'few days and try again. Your winnings are safe.'
                ),
            }), 409

        return jsonify({
            'success': True,
            'action': 'claim',
            'winnings': [{
                'id': w['id'],
                'round_id': w['round_id'],
                'amount_gd': str(w['amount_gd']),
                'match_count': w['match_count'],
            } for w in pending],
        })
    except Exception as exc:  # noqa: BLE001
        logger.error('❌ lotto withdraw preflight failed: %s', exc)
        return jsonify({'success': False, 'error': str(exc)}), 500


@lotto_bp.route('/api/verify-claim', methods=['POST'])
def verify_claim():
    """Backend verifies the winner's claim tx on-chain and marks the DB row
    claimed. The user only pays gas when the vault actually has G$."""
    wallet = _session_wallet()
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401

    data = request.json or {}
    tx_hash = (data.get('tx_hash') or '').strip()
    win_id = data.get('win_id')
    if not tx_hash:
        return jsonify({'success': False, 'error': 'Missing tx_hash'}), 400

    winnings = svc.get_my_winnings(wallet, limit=50)
    win = None
    for w in winnings:
        if str(w.get('id')) == str(win_id):
            win = w
            break
    if not win:
        # Even without win_id, verify against round history by amount + round.
        for w in winnings:
            if str(w.get('round_id')) == str(data.get('round_id')):
                win = w
                break
    if not win:
        return jsonify({'success': False, 'error': 'Winning not found for your wallet.'}), 404

    result = lotto_blockchain.verify_claim_tx(tx_hash, wallet, int(win['round_id']))
    if not result.get('success'):
        return jsonify(result), 400

    from supabase_client import get_supabase_admin_client
    sb = get_supabase_admin_client()
    sb.table('daily_lotto_winnings').update({
        'status': 'claimed',
        'tx_hash': tx_hash,
        'claimed_at': svc._now_utc_iso(),
    }).eq('id', win['id']).execute()

    return jsonify({
        'success': True,
        'amount_gd': str(result['amount_gd']),
        'tx_hash': tx_hash,
        'explorer_url': f'https://celoscan.io/tx/{tx_hash}',
    })


# ── Admin API ─────────────────────────────────────────────────────────────────

def _admin_wallet() -> str | None:
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet:
        return None
    from supabase_client import is_admin
    if not is_admin(wallet):
        return None
    return wallet


@lotto_bp.route('/api/admin/overview')
def admin_overview():
    wallet = _admin_wallet()
    if not wallet:
        return jsonify({'success': False, 'error': 'Admin access required'}), 403
    return jsonify(svc.admin_overview())


@lotto_bp.route('/api/admin/tiers', methods=['GET', 'POST'])
def admin_tiers():
    wallet = _admin_wallet()
    if not wallet:
        return jsonify({'success': False, 'error': 'Admin access required'}), 403
    if request.method == 'GET':
        return jsonify({'success': True, 'tiers': {str(k): str(v) for k, v in svc.get_prize_tiers(use_cache=False).items()}})

    data = request.json or {}
    updates = data.get('tiers')
    if not updates or not isinstance(updates, dict):
        return jsonify({'success': False, 'error': 'tiers must be {match_count: amount}'}), 400
    result = svc.update_prize_tiers(updates, wallet)
    if result.get('success'):
        try:
            from supabase_client import log_admin_action
            log_admin_action(
                admin_wallet=wallet,
                action_type='update_daily_lotto_tiers',
                action_details={'tiers': updates},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning('⚠️ log_admin_action failed: %s', exc)
    return jsonify(result)


@lotto_bp.route('/api/admin/settings', methods=['GET', 'POST'])
def admin_settings():
    wallet = _admin_wallet()
    if not wallet:
        return jsonify({'success': False, 'error': 'Admin access required'}), 403
    if request.method == 'GET':
        return jsonify({
            'success': True,
            'daily_prize_pool_cap_gd': str(svc.get_daily_prize_pool_cap()),
        })
    data = request.json or {}
    if 'daily_prize_pool_cap_gd' in data:
        result = svc.update_daily_prize_pool_cap(data['daily_prize_pool_cap_gd'], wallet)
        return jsonify(result)
    return jsonify({'success': False, 'error': 'Nothing to update'}), 400


@lotto_bp.route('/api/admin/manual-draw', methods=['POST'])
def admin_manual_draw():
    wallet = _admin_wallet()
    if not wallet:
        return jsonify({'success': False, 'error': 'Admin access required'}), 403

    data = request.json or {}
    round_id = int(data.get('round_id') or svc.current_round_metadata()['round_id'])
    # The manual draw uses the same CAS routine as the scheduler, so it can
    # never produce duplicate/reordered winners.
    result = svc.run_draw_for_round(round_id)
    if result.get('success'):
        try:
            from supabase_client import log_admin_action
            log_admin_action(
                admin_wallet=wallet,
                action_type='manual_daily_lotto_draw',
                action_details={'round_id': round_id, 'result': result},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning('⚠️ log_admin_action failed: %s', exc)
    return jsonify(result)


@lotto_bp.route('/api/admin/grant', methods=['POST'])
def admin_grant():
    """Re-run the on-chain grant for a round whose winners are computed but not
    yet granted (e.g. the vault was short when the scheduler tried, or the
    scheduler restarted between draw and grant). Idempotent on-chain."""
    wallet = _admin_wallet()
    if not wallet:
        return jsonify({'success': False, 'error': 'Admin access required'}), 403

    data = request.json or {}
    round_id = int(data.get('round_id') or svc.current_round_metadata()['round_id'])

    sb = svc._get_supabase_admin()
    wins = sb.table('daily_lotto_winnings') \
        .select('wallet_address, amount_gd, status') \
        .eq('round_id', round_id) \
        .execute()
    winner_rows = [w for w in (wins.data or []) if w.get('status') != 'claimed']
    if not winner_rows:
        return jsonify({'success': False, 'error': 'No unclaimed winnings for this round to grant.'}), 400

    winners = [w['wallet_address'] for w in winner_rows]
    amounts = [w['amount_gd'] for w in winner_rows]

    # The contract requires finalizeRound BEFORE grantWinners ('round_not_finalized'
    # revert otherwise) and claim() needs claimable set — without this a manual
    # grant writes nothing on-chain and winners can never pull their prize.
    round_row = svc.get_round(round_id) or {}
    winning_numbers = round_row.get('winning_numbers') or []
    if not winning_numbers:
        return jsonify({'success': False, 'error': 'Round has no winning numbers yet — run the draw first.'}), 400
    finalize = lotto_blockchain.finalize_round(round_id, [int(n) for n in winning_numbers])
    if not finalize.get('success'):
        return jsonify(finalize), 409

    result = lotto_blockchain.grant_winners(round_id, winners, amounts)
    if not result.get('success'):
        return jsonify(result), 409

    sb.table('daily_lotto_rounds').update({'grant_status': 'granted'}).eq('id', round_id).execute()
    try:
        from supabase_client import log_admin_action
        log_admin_action(
            admin_wallet=wallet,
            action_type='manual_daily_lotto_grant',
            action_details={'round_id': round_id, 'tx_hash': result.get('tx_hash')},
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning('⚠️ log_admin_action failed: %s', exc)
    return jsonify(result)


@lotto_bp.route('/api/admin/fund-vault', methods=['POST'])
def admin_fund_vault():
    """Admin quick action: send G$ from the server vault wallet (LOTTO_FUNDING_KEY
    falls back to SERVER_PRIVATE_KEY / GOOODMARKET_LOTTO_KEY) to the Lotto
    contract. Pure ERC20 transfer — no contract call, so it cannot be tampered
    with by the contract."""
    wallet = _admin_wallet()
    if not wallet:
        return jsonify({'success': False, 'error': 'Admin access required'}), 403

    data = request.json or {}
    amount_gd = data.get('amount_gd')
    try:
        amount = Decimal(str(amount_gd))
    except Exception:  # noqa: BLE001
        return jsonify({'success': False, 'error': 'Invalid amount.'}), 400
    if amount <= 0:
        return jsonify({'success': False, 'error': 'Amount must be positive.'}), 400

    if not lotto_blockchain.contract_address:
        return jsonify({'success': False, 'error': 'GOODMARKET_LOTTO_CONTRACT not configured.'}), 500

    result = lotto_blockchain.transfer_to_vault(amount, wallet)
    if result.get('success'):
        try:
            from supabase_client import log_admin_action
            log_admin_action(
                admin_wallet=wallet,
                action_type='fund_daily_lotto_vault',
                action_details={'amount_gd': str(amount), 'tx_hash': result.get('tx_hash')},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning('⚠️ log_admin_action failed: %s', exc)
    return jsonify(result)


@lotto_bp.route('/api/admin/alerts', methods=['GET'])
def admin_alerts():
    wallet = _admin_wallet()
    if not wallet:
        return jsonify({'success': False, 'error': 'Admin access required'}), 403
    return jsonify({'success': True, 'alerts': svc.list_vault_alerts(unresolved_only=True, limit=50)})


@lotto_bp.route('/api/admin/alerts/<int:alert_id>/resolve', methods=['POST'])
def admin_resolve_alert(alert_id: int):
    wallet = _admin_wallet()
    if not wallet:
        return jsonify({'success': False, 'error': 'Admin access required'}), 403
    return jsonify(svc.resolve_vault_alert(alert_id, wallet))


def init_daily_lotto(app):
    try:
        app.register_blueprint(lotto_bp)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.error('❌ Daily Lotto initialization failed: %s', exc)
        return False
