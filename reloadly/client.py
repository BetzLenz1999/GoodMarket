import logging
import requests
from datetime import datetime, timedelta

from env_utils import get_env_str

logger = logging.getLogger(__name__)

# Errors that mean the credential/environment pair is unusable. Reloadly
# answers these from the token endpoint (401 INVALID_CREDENTIALS) or from a
# product endpoint when a token was minted for the wrong environment
# (401 INVALID_TOKEN — "are you in production & using a sandbox token or
# vice-versa?").
_AUTH_ERROR_CODES = ("INVALID_CREDENTIALS", "INVALID_TOKEN")


class ReloadlyClient:
    """Reloadly API Client with OAuth2 authentication"""

    SANDBOX_AUTH_URL = "https://auth.reloadly.com"
    PRODUCTION_AUTH_URL = "https://auth.reloadly.com"

    SANDBOX_TOPUP_URL = "https://topups-sandbox.reloadly.com"
    PRODUCTION_TOPUP_URL = "https://topups.reloadly.com"

    SANDBOX_GIFTCARD_URL = "https://giftcards-sandbox.reloadly.com"
    PRODUCTION_GIFTCARD_URL = "https://giftcards.reloadly.com"

    SANDBOX_UTILITY_URL = "https://utilities-sandbox.reloadly.com"
    PRODUCTION_UTILITY_URL = "https://utilities.reloadly.com"

    def __init__(self):
        # Cleaned via env_utils so a value that is set-but-empty (``VAR=``), a
        # quoted value (``"sandbox"``) or one with stray whitespace still
        # resolves correctly. Without this, an empty/quoted environment silently
        # fell through to PRODUCTION endpoints while the credentials were test
        # ones — the 401 INVALID_CREDENTIALS cascade reported from production.
        self.client_id = get_env_str("RELOADLY_CLIENT_ID")
        self.client_secret = get_env_str("RELOADLY_CLIENT_SECRET")
        self.environment = get_env_str("RELOADLY_ENVIRONMENT", "sandbox", lower=True)

        self.is_sandbox = self.environment == "sandbox"

        self.auth_url = self.SANDBOX_AUTH_URL if self.is_sandbox else self.PRODUCTION_AUTH_URL
        self.topup_url = self.SANDBOX_TOPUP_URL if self.is_sandbox else self.PRODUCTION_TOPUP_URL
        self.giftcard_url = self.SANDBOX_GIFTCARD_URL if self.is_sandbox else self.PRODUCTION_GIFTCARD_URL
        self.utility_url = self.SANDBOX_UTILITY_URL if self.is_sandbox else self.PRODUCTION_UTILITY_URL

        self._topup_token = None
        self._topup_token_expiry = None
        self._giftcard_token = None
        self._giftcard_token_expiry = None
        self._utility_token = None
        self._utility_token_expiry = None

        self.is_initialized = bool(self.client_id and self.client_secret)
        if self.is_initialized:
            logger.info(f"✅ Reloadly client initialized ({self.environment})")
        else:
            logger.warning("⚠️ Reloadly credentials not configured")

    def _get_token(self, audience: str) -> str:
        """Get OAuth2 access token for the given audience"""
        try:
            payload = {
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "grant_type": "client_credentials",
                "audience": audience
            }
            response = requests.post(
                f"{self.auth_url}/oauth/token",
                json=payload,
                timeout=15
            )
            response.raise_for_status()
            data = response.json()
            return data.get("access_token")
        except Exception as e:
            logger.error(f"❌ Reloadly auth error for {audience}: {e}")
            raise

    def _get_topup_token(self) -> str:
        now = datetime.utcnow()
        if self._topup_token and self._topup_token_expiry and now < self._topup_token_expiry:
            return self._topup_token
        audience = "https://topups-sandbox.reloadly.com" if self.is_sandbox else "https://topups.reloadly.com"
        self._topup_token = self._get_token(audience)
        self._topup_token_expiry = now + timedelta(hours=1)
        return self._topup_token

    def _get_giftcard_token(self) -> str:
        now = datetime.utcnow()
        if self._giftcard_token and self._giftcard_token_expiry and now < self._giftcard_token_expiry:
            return self._giftcard_token
        audience = "https://giftcards-sandbox.reloadly.com" if self.is_sandbox else "https://giftcards.reloadly.com"
        self._giftcard_token = self._get_token(audience)
        self._giftcard_token_expiry = now + timedelta(hours=1)
        return self._giftcard_token

    def _get_utility_token(self) -> str:
        now = datetime.utcnow()
        if self._utility_token and self._utility_token_expiry and now < self._utility_token_expiry:
            return self._utility_token
        audience = "https://utilities-sandbox.reloadly.com" if self.is_sandbox else "https://utilities.reloadly.com"
        self._utility_token = self._get_token(audience)
        self._utility_token_expiry = now + timedelta(hours=1)
        return self._utility_token

    def _topup_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._get_topup_token()}",
            "Content-Type": "application/json",
            "Accept": "application/com.reloadly.topups-v1+json"
        }

    def _giftcard_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._get_giftcard_token()}",
            "Content-Type": "application/json",
            "Accept": "application/com.reloadly.giftcards-v1+json"
        }

    def _utility_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._get_utility_token()}",
            "Content-Type": "application/json",
            "Accept": "application/com.reloadly.utilities-v1+json"
        }

    def _invalidate_token(self, kind: str) -> None:
        """Drop a cached token so the next call re-mints it.

        Used when Reloadly answers 401: the credential may have been rotated, or
        the cached token may belong to the other environment. Re-minting turns a
        revoked-then-reissued secret into a self-healing retry instead of an hour
        of failures until the in-memory cache lapses.
        """
        if kind == "topup":
            self._topup_token = None
            self._topup_token_expiry = None
        elif kind == "giftcard":
            self._giftcard_token = None
            self._giftcard_token_expiry = None
        elif kind == "utility":
            self._utility_token = None
            self._utility_token_expiry = None

    def _request(self, kind: str, method: str, url: str, **kwargs):
        """Send an authenticated request, re-minting the token once on a 401.

        A 401 here means the token (or the credential/environment pair) was
        rejected. Re-minting and retrying once recovers automatically from a
        rotated secret or a cached token minted for the wrong environment; a
        second 401 is a genuine credential problem and propagates to the caller.
        """
        headers_fn = {
            "topup": self._topup_headers,
            "giftcard": self._giftcard_headers,
            "utility": self._utility_headers,
        }[kind]
        send = requests.get if method.upper() == "GET" else requests.post

        resp = send(url, headers=headers_fn(), **kwargs)
        if resp.status_code == 401:
            logger.warning(
                "⚠️ Reloadly 401 for %s — re-minting token (%s) and retrying once",
                url, self.environment,
            )
            self._invalidate_token(kind)
            resp = send(url, headers=headers_fn(), **kwargs)
        resp.raise_for_status()
        return resp

    # ─── TOP-UP ────────────────────────────────────────────────────────────────

    def get_topup_operators(self, country_code: str) -> list:
        """Get mobile operators for a country"""
        try:
            url = f"{self.topup_url}/operators/countries/{country_code}"
            resp = self._request("topup", "GET", url, timeout=15)
            return resp.json()
        except Exception as e:
            logger.error(f"❌ get_topup_operators error: {e}")
            raise

    def get_operator_products(self, operator_id: int) -> dict:
        """Get products/denominations for a specific operator"""
        try:
            url = f"{self.topup_url}/operators/{operator_id}"
            resp = self._request("topup", "GET", url, timeout=15)
            return resp.json()
        except Exception as e:
            logger.error(f"❌ get_operator_products error: {e}")
            raise

    def auto_detect_operator(self, phone_number: str, country_code: str) -> dict:
        """Auto-detect the operator for a phone number"""
        try:
            url = f"{self.topup_url}/operators/auto-detect/phone/{phone_number}/countries/{country_code}"
            params = {"suggestedAmountsMap": "true", "suggestedAmounts": "true"}
            resp = self._request("topup", "GET", url, params=params, timeout=15)
            return resp.json()
        except Exception as e:
            logger.error(f"❌ auto_detect_operator error: {e}")
            raise

    def send_topup(self, operator_id: int, amount: float, phone_number: str, country_code: str, custom_identifier: str = None) -> dict:
        """Send a mobile top-up"""
        try:
            payload = {
                "operatorId": operator_id,
                "amount": amount,
                "useLocalAmount": False,
                "customIdentifier": custom_identifier or f"order_{datetime.utcnow().timestamp()}",
                "recipientPhone": {
                    "countryCode": country_code,
                    "number": phone_number
                }
            }
            resp = self._request(
                "topup", "POST", f"{self.topup_url}/topups",
                json=payload, timeout=30,
            )
            return resp.json()
        except Exception as e:
            logger.error(f"❌ send_topup error: {e}")
            raise

    def get_topup_transaction(self, transaction_id: int) -> dict:
        """Get top-up transaction status"""
        try:
            url = f"{self.topup_url}/topups/reports/transactions/{transaction_id}"
            resp = self._request("topup", "GET", url, timeout=15)
            return resp.json()
        except Exception as e:
            logger.error(f"❌ get_topup_transaction error: {e}")
            raise

    # ─── DATA BUNDLES ──────────────────────────────────────────────────────────

    def get_data_operators(self, country_code: str) -> list:
        """Get data bundle operators for a country"""
        try:
            url = f"{self.topup_url}/operators/countries/{country_code}"
            params = {"bundlesOnly": "true"}
            resp = self._request("topup", "GET", url, params=params, timeout=15)
            return resp.json()
        except Exception as e:
            logger.error(f"❌ get_data_operators error: {e}")
            raise

    # ─── GIFT CARDS ────────────────────────────────────────────────────────────

    def get_giftcard_products(self, country_code: str = None, page: int = 1, size: int = 20) -> dict:
        """Get available gift card products"""
        try:
            url = f"{self.giftcard_url}/products"
            params = {"size": size, "page": page}
            if country_code:
                params["countryCode"] = country_code
            resp = self._request("giftcard", "GET", url, params=params, timeout=15)
            return resp.json()
        except Exception as e:
            logger.error(f"❌ get_giftcard_products error: {e}")
            raise

    def get_giftcard_product(self, product_id: int) -> dict:
        """Get a specific gift card product"""
        try:
            url = f"{self.giftcard_url}/products/{product_id}"
            resp = self._request("giftcard", "GET", url, timeout=15)
            return resp.json()
        except Exception as e:
            logger.error(f"❌ get_giftcard_product error: {e}")
            raise

    def order_giftcard(self, product_id: int, quantity: int, unit_price: float, custom_identifier: str = None) -> dict:
        """Order a gift card"""
        try:
            payload = {
                "productId": product_id,
                "quantity": quantity,
                "unitPrice": unit_price,
                "customIdentifier": custom_identifier or f"gc_{datetime.utcnow().timestamp()}"
            }
            resp = self._request(
                "giftcard", "POST", f"{self.giftcard_url}/orders",
                json=payload, timeout=30,
            )
            return resp.json()
        except Exception as e:
            logger.error(f"❌ order_giftcard error: {e}")
            raise

    def get_giftcard_order(self, order_id: int) -> dict:
        """Get gift card order status"""
        try:
            url = f"{self.giftcard_url}/orders/transactions/{order_id}"
            resp = self._request("giftcard", "GET", url, timeout=15)
            return resp.json()
        except Exception as e:
            logger.error(f"❌ get_giftcard_order error: {e}")
            raise

    def get_giftcard_redeem_code(self, transaction_id) -> dict:
        """
        Fetch the redeem code (card number, PIN, etc.) for a completed
        gift card order. For Visa/Mastercard virtual prepaid cards, this
        returns the card number, CVV/PIN, and expiry.
        Reloadly docs: GET /orders/transactions/{transactionId}/cards
        """
        try:
            url = f"{self.giftcard_url}/orders/transactions/{transaction_id}/cards"
            resp = self._request("giftcard", "GET", url, timeout=15)
            return resp.json()
        except Exception as e:
            logger.error(f"❌ get_giftcard_redeem_code error: {e}")
            raise

    def get_giftcard_categories(self) -> list:
        """Get gift card product categories (e.g. 'Prepaid Visa', 'Money Cards')."""
        try:
            url = f"{self.giftcard_url}/categories"
            resp = self._request("giftcard", "GET", url, timeout=15)
            data = resp.json()
            return data.get("content", data) if isinstance(data, dict) else data
        except Exception as e:
            logger.error(f"❌ get_giftcard_categories error: {e}")
            raise

    # ─── UTILITY PAYMENTS ──────────────────────────────────────────────────────

    def get_utility_billers(self, country_code: str = None) -> list:
        """Get utility billers"""
        try:
            url = f"{self.utility_url}/billers"
            params = {}
            if country_code:
                params["countryISOCode"] = country_code
            resp = self._request("utility", "GET", url, params=params, timeout=15)
            return resp.json().get("content", [])
        except Exception as e:
            logger.error(f"❌ get_utility_billers error: {e}")
            raise

    def pay_utility(self, biller_id: int, amount: float, subscriber_id: str, custom_identifier: str = None) -> dict:
        """Pay a utility bill"""
        try:
            payload = {
                "billerId": biller_id,
                "amount": amount,
                "subscriberId": subscriber_id,
                "customIdentifier": custom_identifier or f"util_{datetime.utcnow().timestamp()}"
            }
            resp = self._request(
                "utility", "POST", f"{self.utility_url}/billers/{biller_id}/pay",
                json=payload, timeout=30,
            )
            return resp.json()
        except Exception as e:
            logger.error(f"❌ pay_utility error: {e}")
            raise

    def _countries_public_headers(self) -> dict:
        """Headers for the anonymous countries catalog request."""
        return {
            "Content-Type": "application/json",
            "Accept": "application/com.reloadly.topups-v1+json",
        }

    def get_countries(self) -> list:
        """Get list of supported countries for top-ups.

        The countries catalog is a public endpoint — Reloadly serves the full
        list without an Authorization header. Authenticating is still preferred
        so the request honours the configured environment, but a missing,
        expired, or rejected credential must not blank the country picker, so
        an anonymous request is used as the fallback.
        """
        url = f"{self.topup_url}/countries"
        if self.is_initialized:
            try:
                resp = self._request("topup", "GET", url, timeout=15)
                data = resp.json()
                if isinstance(data, list):
                    return data
                logger.warning("⚠️ get_countries returned a non-list payload; trying public catalog")
            except Exception as e:
                logger.warning(f"⚠️ get_countries authenticated fetch failed ({e}); trying public catalog")
        try:
            resp = requests.get(url, headers=self._countries_public_headers(), timeout=15)
            resp.raise_for_status()
            data = resp.json()
            if not isinstance(data, list):
                raise ValueError(f"Unexpected countries payload: {type(data).__name__}")
            return data
        except Exception as e:
            logger.error(f"❌ get_countries error: {e}")
            raise

    # ─── DIAGNOSTICS ───────────────────────────────────────────────────────────

    def check_credentials(self) -> dict:
        """Report the resolved config and whether Reloadly accepts the credential.

        Never raises: a failed probe is reported as ``auth_ok: False`` with the
        real error, so an admin can tell a wrong environment / revoked secret
        apart from a genuine Reloadly outage instead of guessing from the
        generic "Service temporarily unavailable" the UI shows.
        """
        info = {
            "credentials_configured": self.is_initialized,
            "environment": self.environment,
            "is_sandbox": self.is_sandbox,
            "auth_url": self.auth_url,
            "topup_url": self.topup_url,
            "client_id_suffix": (self.client_id or "")[-4:] if self.client_id else None,
            "auth_ok": False,
            "error": None,
        }
        if not self.is_initialized:
            info["error"] = (
                "RELOADLY_CLIENT_ID / RELOADLY_CLIENT_SECRET are not set. "
                "Set them in the environment and redeploy."
            )
            return info

        audience = "https://topups-sandbox.reloadly.com" if self.is_sandbox else "https://topups.reloadly.com"
        try:
            # Always mint fresh so the probe reflects the current credential, not
            # a cached token from before a rotation.
            self._invalidate_token("topup")
            token = self._get_token(audience)
            info["auth_ok"] = bool(token)
            if not token:
                info["error"] = "Reloadly returned no access token."
        except Exception as e:  # noqa: BLE001 - diagnostics must never raise
            info["error"] = str(e)
            info["hint"] = (
                "401 INVALID_CREDENTIALS means the client_id/secret is wrong, "
                "revoked, or belongs to the other environment. Verify "
                "RELOADLY_ENVIRONMENT matches the credentials' mode (Sandbox vs "
                "Live) in the Reloadly dashboard, and that the values have no "
                "surrounding quotes or trailing spaces."
            )
        return info


reloadly_client = ReloadlyClient()
