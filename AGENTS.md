"""Content tests for the GCash Cashout feature.

Validates the gcash/ backend package, SQL migration, wallet.html modal,
admin_dashboard.html section, and main.py wiring — no flask/web3/requests
dependencies needed.
"""
import os
import re

ROOT = os.path.join(os.path.dirname(__file__), "..")


def _read(path):
    with open(os.path.join(ROOT, path)) as f:
        return f.read()


# ── SQL migration ────────────────────────────────────────────────────────────

def test_sql_creates_gcash_table():
    sql = _read("sql/gcash_cashout.sql")
    assert "CREATE TABLE IF NOT EXISTS gcash_cashout_requests" in sql
    assert "wallet_address" in sql
    assert "gcash_number" in sql
    assert "gcash_name" in sql
    assert "amount_gd" in sql
    assert "amount_php" in sql
    assert "tx_hash" in sql
    assert "UNIQUE" in sql  # tx_hash unique constraint


def test_sql_has_all_statuses():
    sql = _read("sql/gcash_cashout.sql")
    for status in ["pending", "refunding", "approved", "rejected", "refunded", "refund_failed"]:
        assert f"'{status}'" in sql, f"Missing status: {status}"


def test_sql_has_indexes():
    sql = _read("sql/gcash_cashout.sql")
    assert "idx_gcash_status" in sql
    assert "idx_gcash_wallet" in sql
    assert "idx_gcash_created" in sql


def test_sql_has_updated_at_trigger():
    sql = _read("sql/gcash_cashout.sql")
    assert "update_gcash_updated_at" in sql
    assert "trg_gcash_updated_at" in sql


def test_sql_has_proof_columns():
    sql = _read("sql/gcash_cashout.sql")
    assert "reference_number" in sql
    assert "receipt_image_url" in sql
    # ALTER safety for installs that ran the earlier migration
    assert "ADD COLUMN IF NOT EXISTS reference_number" in sql
    assert "ADD COLUMN IF NOT EXISTS receipt_image_url" in sql


# ── gcash/service.py ─────────────────────────────────────────────────────────

def test_service_has_validation():
    src = _read("gcash/service.py")
    assert "def validate_cashout_request" in src
    assert "MIN_CASHOUT_GD" in src
    assert "GCASH_NUMBER_RE" in src
    assert "GCASH_NAME_RE" in src


def test_service_minimum_is_5000():
    src = _read("gcash/service.py")
    assert 'Decimal("5000")' in src


def test_service_rate_is_100_per_peso():
    src = _read("gcash/service.py")
    assert 'Decimal("100")' in src


def test_service_gcash_number_regex():
    src = _read("gcash/service.py")
    assert r"^09\d{9}$" in src


def test_service_has_verify_payment_tx():
    src = _read("gcash/service.py")
    assert "def verify_payment_tx" in src
    assert "receipt.status" in src or "receipt['status']" in src


def test_service_has_send_refund():
    src = _read("gcash/service.py")
    assert "def send_refund" in src
    assert "insufficient_gas" in src


def test_service_has_cas_claim():
    src = _read("gcash/service.py")
    assert "def claim_request_for_refund" in src
    assert '.eq("status", expected_status)' in src


def test_service_has_gas_preflight():
    src = _read("gcash/service.py")
    assert "estimate_gas" in src
    assert "_REFUND_GAS_FALLBACK" in src
    assert "_REFUND_GAS_CAP" in src


def test_service_uses_gcash_env_vars():
    src = _read("gcash/service.py")
    assert 'os.getenv("GCASH_ADDRESS"' in src
    assert 'os.getenv("GCASH_KEY"' in src


def test_service_24h_auto_refund():
    src = _read("gcash/service.py")
    assert "24" in src
    assert "AUTO_REFUND_HOURS" in src


# ── gcash/routes.py ──────────────────────────────────────────────────────────

def test_routes_has_user_endpoints():
    src = _read("gcash/routes.py")
    assert '"/cashout-request"' in src
    assert '"/my-requests"' in src
    assert '"/config"' in src


def test_routes_has_admin_endpoints():
    src = _read("gcash/routes.py")
    assert '"/admin/requests"' in src
    assert '/approve"' in src
    assert '/reject"' in src


def test_routes_auth_required():
    src = _read("gcash/routes.py")
    assert "_auth_wallet" in src
    assert "_require_admin" in src


def test_routes_one_pending_per_user():
    src = _read("gcash/routes.py")
    assert "get_pending_request_for_wallet" in src
    assert "already have a pending" in src


def test_routes_reject_triggers_refund():
    src = _read("gcash/routes.py")
    assert "send_refund" in src
    assert "claim_request_for_refund" in src


def test_routes_approve_requires_reference_number():
    src = _read("gcash/routes.py")
    approve = src.split("def admin_approve", 1)[1].split("def admin_reject", 1)[0]
    assert "reference_number" in approve
    assert "reference number is required" in approve


def test_routes_approve_requires_receipt_upload():
    src = _read("gcash/routes.py")
    approve = src.split("def admin_approve", 1)[1].split("def admin_reject", 1)[0]
    assert "receipt_image" in approve
    assert "upload_to_imgbb" in approve
    assert "Receipt screenshot is required" in approve


def test_routes_approve_stores_proof():
    src = _read("gcash/routes.py")
    approve = src.split("def admin_approve", 1)[1].split("def admin_reject", 1)[0]
    assert '"reference_number": reference_number' in approve
    assert '"receipt_image_url": receipt_url' in approve
    assert "Successful" in approve


# ── gcash/refund_retry.py ────────────────────────────────────────────────────

def test_refund_scheduler_has_env_gate():
    src = _read("gcash/refund_retry.py")
    assert "GCASH_AUTO_REFUND_ENABLED" in src
    assert "GCASH_AUTO_REFUND_INTERVAL_SEC" in src


def test_refund_scheduler_fetches_expired():
    src = _read("gcash/refund_retry.py")
    assert "lt(" in src or ".lt(" in src  # created_at < cutoff
    assert "24" in src  # 24 hours


def test_refund_scheduler_uses_cas_claim():
    src = _read("gcash/refund_retry.py")
    assert "claim_request_for_refund" in src


def test_refund_scheduler_marks_refunded():
    src = _read("gcash/refund_retry.py")
    assert '"refunded"' in src
    assert '"refund_failed"' in src


# ── gcash/__init__.py ───────────────────────────────────────────────────────

def test_init_registers_blueprint():
    src = _read("gcash/__init__.py")
    assert "gcash_bp" in src
    assert "register_blueprint" in src


# ── main.py wiring ────────────────────────────────────────────────────────────

def test_main_registers_gcash():
    src = _read("main.py")
    assert "from gcash import init_gcash" in src
    assert "init_gcash(app)" in src


def test_main_starts_gcash_scheduler():
    src = _read("main.py")
    assert "from gcash.refund_retry import init_gcash_refund_scheduler" in src
    assert "init_gcash_refund_scheduler(app)" in src


# ── wallet.html — GCash modal ────────────────────────────────────────────────

def test_wallet_has_gcash_modal():
    src = _read("templates/wallet.html")
    assert 'id="gcashModal"' in src
    assert "GCash Cashout" in src
    assert "gcashAmount" in src
    assert "gcashNumber" in src
    assert "gcashName" in src


def test_wallet_has_gcash_instructions():
    src = _read("templates/wallet.html")
    assert "100 G$ = ₱1.00" in src
    assert "5,000 G$" in src
    assert "Philippines" in src
    assert "automatically refunded" in src
    assert "1–24 hours" in src


def test_wallet_has_submit_function():
    src = _read("templates/wallet.html")
    assert "async function submitGcashCashout()" in src
    assert "gcash/cashout-request" in src


def test_wallet_validates_gcash_number():
    src = _read("templates/wallet.html")
    assert r"09\d{9}" in src
    assert "11 digits" in src


def test_wallet_validates_minimum():
    src = _read("templates/wallet.html")
    gcash_fn = src.split("submitGcashCashout()", 1)[1]
    assert "5000" in gcash_fn


def test_wallet_has_php_preview():
    src = _read("templates/wallet.html")
    assert "_gcashUpdatePhp" in src
    assert "gcashPhpPreview" in src


def test_wallet_has_history_section():
    src = _read("templates/wallet.html")
    assert "gcashHistorySection" in src
    assert "_gcashLoadHistory" in src
    assert "my-requests" in src


def test_wallet_history_shows_successful_with_proof():
    src = _read("templates/wallet.html")
    history_fn = src.split("_gcashLoadHistory()", 1)[1]
    assert "SUCCESSFUL" in history_fn
    assert "reference_number" in history_fn
    assert "receipt_image_url" in history_fn
    assert "View receipt" in history_fn


def test_wallet_history_shows_refund_link():
    src = _read("templates/wallet.html")
    history_fn = src.split("_gcashLoadHistory()", 1)[1]
    assert "refund_tx_hash" in history_fn
    assert "celoscan.io/tx/" in history_fn


def test_wallet_gcash_uses_existing_signer():
    """GCash cashout must use the same signer routing as doSend (local/injected/WC)."""
    src = _read("templates/wallet.html")
    gcash_fn = src.split("submitGcashCashout()", 1)[1]
    assert "isLocalLogin" in gcash_fn
    assert "GMLocalWallet.getProvider()" in gcash_fn
    assert "_vAwaitEthProvider" in gcash_fn
    assert "_walletGetWcProviderIfPreferred" in gcash_fn


def test_wallet_gcash_prepares_send():
    src = _read("templates/wallet.html")
    gcash_fn = src.split("submitGcashCashout()", 1)[1]
    assert "/api/wallet/prepare-send" in gcash_fn
    assert "eth_sendTransaction" in gcash_fn


# ── admin_dashboard.html — GCash section ─────────────────────────────────────

def test_admin_has_gcash_section():
    src = _read("templates/admin_dashboard.html")
    assert 'id="gcash-cashout-section"' in src
    assert "GCash Cashout Requests" in src


def test_admin_has_gcash_nav_link():
    src = _read("templates/admin_dashboard.html")
    assert "gcash-cashout-section" in src
    assert "GCash Cashout" in src


def test_admin_has_status_filter():
    src = _read("templates/admin_dashboard.html")
    assert "gcashStatusFilter" in src
    assert "pending" in src
    assert "approved" in src
    assert "rejected" in src
    assert "refunded" in src


def test_admin_has_table():
    src = _read("templates/admin_dashboard.html")
    assert "gcashTable" in src
    assert "gcashTableBody" in src


def test_admin_has_load_function():
    src = _read("templates/admin_dashboard.html")
    assert "async function loadGcashRequests()" in src
    assert "/api/gcash/admin/requests" in src


def test_admin_has_approve_reject():
    src = _read("templates/admin_dashboard.html")
    assert "function gcashApprove(" in src
    assert "async function gcashReject(" in src
    assert "/approve" in src
    assert "/reject" in src


def test_admin_approve_modal_has_reference_and_receipt():
    src = _read("templates/admin_dashboard.html")
    assert 'id="gcashApproveModal"' in src
    assert 'id="gcashApproveRef"' in src
    assert 'id="gcashApproveFile"' in src
    assert 'accept="image/*"' in src


def test_admin_approve_submits_formdata():
    src = _read("templates/admin_dashboard.html")
    assert "async function gcashApproveSubmit()" in src
    assert "new FormData()" in src
    assert "fd.append('reference_number'" in src
    assert "fd.append('receipt_image'" in src


def test_admin_table_shows_reference_and_receipt():
    src = _read("templates/admin_dashboard.html")
    assert "r.reference_number" in src
    assert "r.receipt_image_url" in src
    assert "📷 Receipt" in src


def test_admin_load_section_data_routing():
    src = _read("templates/admin_dashboard.html")
    assert "gcash-cashout" in src
    assert "loadGcashRequests" in src
