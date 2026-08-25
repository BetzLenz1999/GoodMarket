import logging
from flask import Blueprint, request, jsonify, render_template, session, redirect
from .jumble_service import jumble_service

logger = logging.getLogger(__name__)

jumble_bp = Blueprint('jumble', __name__, url_prefix='/jumble')


@jumble_bp.route('/')
def jumble_game():
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

    return render_template('jumble_game.html', wallet=wallet)


@jumble_bp.route('/api/get-word')
def get_word():
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet or not (session.get('verified') or session.get('ubi_verified')):
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    result = jumble_service.get_random_word(wallet)
    return jsonify(result)


@jumble_bp.route('/api/submit-answer', methods=['POST'])
def submit_answer():
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet or not (session.get('verified') or session.get('ubi_verified')):
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    data = request.json or {}
    word_id = data.get('word_id')
    answer = data.get('answer', '').strip()
    if not word_id or not answer:
        return jsonify({'success': False, 'error': 'Missing word_id or answer'}), 400
    result = jumble_service.submit_answer(wallet, word_id, answer)
    return jsonify(result)


@jumble_bp.route('/api/daily-status')
def daily_status():
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet or not (session.get('verified') or session.get('ubi_verified')):
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    wins = jumble_service.get_daily_wins(wallet)
    return jsonify({
        'success': True,
        'daily_wins': wins,
        'max_wins': 10,
        'remaining': max(0, 10 - wins),
        'limit_reached': wins >= 10
    })


@jumble_bp.route('/api/leaderboard')
def leaderboard():
    result = jumble_service.get_leaderboard()
    return jsonify(result)


@jumble_bp.route('/api/get-review-contents')
def get_review_contents():
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet or not (session.get('verified') or session.get('ubi_verified')):
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    result = jumble_service.get_all_contents()
    return jsonify(result)


@jumble_bp.route('/admin/add-content', methods=['POST'])
def admin_add_content():
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    data = request.json or {}
    content_text = data.get('content_text', '').strip()
    if not content_text or len(content_text) < 10:
        return jsonify({'success': False, 'error': 'Content text is too short.'}), 400
    result = jumble_service.add_content(content_text, added_by=wallet)
    return jsonify(result)


@jumble_bp.route('/admin/get-contents')
def admin_get_contents():
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    result = jumble_service.get_all_contents()
    return jsonify(result)


@jumble_bp.route('/admin/delete-content/<int:content_id>', methods=['DELETE'])
def admin_delete_content(content_id):
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    result = jumble_service.delete_content(content_id)
    return jsonify(result)


@jumble_bp.route('/admin/get-words/<int:content_id>')
def admin_get_words(content_id):
    wallet = session.get('wallet') or session.get('wallet_address')
    if not wallet:
        return jsonify({'success': False, 'error': 'Not authenticated'}), 401
    try:
        from supabase_client import get_supabase_client
        sb = get_supabase_client()
        res = sb.table('jumble_words').select('id, word, jumbled').eq('content_id', content_id).execute()
        return jsonify({'success': True, 'words': res.data or []})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})
