import logging
from flask import Blueprint, request, jsonify, render_template, session, redirect
from .price_prediction_service import price_prediction_service
from maintenance_service import maintenance_service

logger = logging.getLogger(__name__)

price_prediction_bp = Blueprint('price_prediction', __name__, url_prefix='/price-prediction')


@price_prediction_bp.route('/')
def price_prediction_home():
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

    maintenance_status = maintenance_service.get_maintenance_status('minigames')
    if maintenance_status.get('is_maintenance', False):
        return redirect('/minigames/')

    return render_template('price_prediction.html', wallet=wallet)


@price_prediction_bp.route('/api/prices')
def get_prices():
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    result = price_prediction_service.get_live_prices()
    return jsonify(result)


@price_prediction_bp.route('/api/status')
def get_status():
    """Combined endpoint: resolve + active + history in a single call."""
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401

    resolved = price_prediction_service.check_and_resolve(wallet)
    active = price_prediction_service.get_active_prediction(wallet)
    history = price_prediction_service.get_prediction_history(wallet)

    return jsonify({
        'success': True,
        'resolved': resolved.get('resolved', []),
        'prediction': active.get('prediction'),
        'predictions': history.get('predictions', [])
    })


@price_prediction_bp.route('/api/submit', methods=['POST'])
def submit_prediction():
    wallet = session.get('wallet') or session.get('wallet_address')
    verified = session.get('verified') or session.get('ubi_verified')

    if not wallet or not verified:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401

    data = request.get_json()
    crypto = data.get('crypto', '').strip()
    direction = data.get('direction', '').strip()
    timeframe_minutes = int(data.get('timeframe_minutes', 0))

    if not crypto or not direction or not timeframe_minutes:
        return jsonify({'success': False, 'error': 'Missing required fields.'}), 400

    result = price_prediction_service.submit_prediction(wallet, crypto, direction, timeframe_minutes)
    return jsonify(result)


@price_prediction_bp.route('/api/active')
def get_active():
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    result = price_prediction_service.get_active_prediction(wallet)
    return jsonify(result)


@price_prediction_bp.route('/api/history')
def get_history():
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    result = price_prediction_service.get_prediction_history(wallet)
    return jsonify(result)


@price_prediction_bp.route('/api/live')
def get_live_predictions():
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    result = price_prediction_service.get_all_active_predictions(current_wallet=wallet)
    return jsonify(result)


@price_prediction_bp.route('/api/check-resolve')
def check_resolve():
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    result = price_prediction_service.check_and_resolve(wallet)
    return jsonify(result)


@price_prediction_bp.route('/api/sparklines')
def get_sparklines():
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    result = price_prediction_service.get_sparklines()
    return jsonify(result)
