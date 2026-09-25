"""═══════════════════════════════════════════════════════════════════════════
 THE ONLY FILE YOU EDIT TO TRANSLATE GOODMARKET
═══════════════════════════════════════════════════════════════════════════

Add a line to the relevant language below and the string switches EVERYWHERE it
appears — wallet, dashboard, homepage, swap, savings, lotto, farming, reloadly,
minigames, and runtime JS messages. No other file needs touching.

    "English text as it appears in the app": "Translated text",

Rules
-----
1. The KEY must match the English source EXACTLY (spacing is collapsed, so a
   newline in the template is fine). To find strings that are still missing:

       python scripts/extract_translations.py

   It prints ready-to-paste lines for every untranslated string.
2. Do NOT translate these — they are brand/protocol names and token tickers:
   G$, GoodMarket, GoodDollar, Celo, XDC, GCash, Reloadly, XSwap, GoodSwap,
   Superfluid, WalletConnect, MetaMask, USDT, cUSD, CELO.
3. Never drop or invent a {variable}: a key containing {{ x }} or {0} is
   skipped by the engine on purpose, so translating a fragment cannot corrupt
   a value.
4. This file is loaded once per process and cached. After editing, restart the
   app (or call i18n.clear_catalog_cache()).
5. Money/financial and irreversible-action copy ("Sign this transaction",
   GCash amounts, refunds) should be reviewed by a native speaker before ship.

Both Filipino and Spanish below are first-draft translations for native review.
Filipino deliberately uses the everyday Taglish register the app already speaks
in (e.g. "I-claim", "Ipadala") because formal Tagalog reads unnaturally here.
"""
from __future__ import annotations

# fmt: off

FILIPINO = {
    # ── Navigation / shared chrome ─────────────────────────────────────
    "Settings": "Mga Setting",
    "Close": "Isara",
    "Cancel": "Kanselahin",
    "Confirm": "Kumpirmahin",
    "Continue": "Magpatuloy",
    "Back": "Bumalik",
    "Next": "Susunod",
    "Save": "I-save",
    "Loading…": "Naglo-load…",
    "Loading...": "Naglo-load...",
    "Processing, please wait…": "Pinoproseso, maghintay lang…",
    "Copy": "Kopyahin",
    "Copied!": "Nakopya!",
    "Refresh": "I-refresh",
    "Retry": "Subukan muli",
    "Submit": "Isumite",
    "Send": "Ipadala",
    "Receive": "Tumanggap",
    "Earn": "Kumita",
    "More": "Higit pa",
    "Language": "Wika",
    "Logout": "Mag-logout",
    "Log in": "Mag-login",
    "Transaction History": "Kasaysayan ng Transaksyon",
    "No transactions yet": "Wala pang transaksyon",

    # ── Generic status / errors ────────────────────────────────────────
    "Success!": "Tagumpay!",
    "Failed": "Nabigo",
    "Pending": "Nakabinbin",
    "Completed": "Tapos na",
    "Claimed": "Na-claim na",
    "Rejected": "Tinanggihan",
    "Approved": "Inaprubahan",
    "Insufficient balance": "Kulang ang balanse",
    "Insufficient gas": "Kulang ang gas",
    "Something went wrong": "May nangyaring mali",
    "Please try again": "Pakisubukan muli",
    "Please try again.": "Pakisubukan muli.",
    "Network error": "Error sa network",
    "Connection failed": "Nabigo ang koneksyon",
    "Transaction failed": "Nabigo ang transaksyon",
    "Sign this transaction": "Pirmahan ang transaksyong ito",
    "Sign & Continue": "Pirmahan at magpatuloy",
    "Signing…": "Pinipirmahan…",
    "Waiting for confirmation…": "Naghihintay ng kumpirmasyon…",

    # ── Wallet hub ─────────────────────────────────────────────────────
    "Claim G$": "I-claim ang G$",
    "Claim G$ to My Wallet": "I-claim ang G$ sa aking wallet",
    "Claim UBI G$": "I-claim ang UBI G$",
    "Claimable UBI": "Pwedeng i-claim na UBI",
    "Recipient Address": "Address ng Tatanggap",
    "Amount": "Halaga",
    "Amount to receive": "Halagang matatanggap",
    "Amount to claim": "Halagang ike-claim",
    "Flow Rate": "Bilis ng daloy",
    "For gas fees": "Para sa gas fees",
    "Supported Tokens · Celo Network": "Mga Suportadong Token · Celo Network",
    "Supported Tokens · XDC Network": "Mga Suportadong Token · XDC Network",
    "Celo UBI Pool Balance": "Balanse ng Celo UBI Pool",
    "Checking networks…": "Sinusuri ang mga network…",
    "Checking payment...": "Sinusuri ang bayad...",
    "Wallet detected! Claim your G$ directly here.":
        "Nadetect ang wallet! I-claim ang G$ mo dito mismo.",
    "Preparing wallet connection...": "Inihahanda ang koneksyon ng wallet...",
    "Waiting for wallet to connect...": "Naghihintay na kumonekta ang wallet...",
    "Your wallet will prompt you to confirm the transaction on the Celo network.":
        "Hihilingin ng wallet mo na kumpirmahin ang transaksyon sa Celo network.",
    "Scan with MetaMask, TrustWallet, or any Celo-compatible wallet to receive your G$.":
        "I-scan gamit ang MetaMask, TrustWallet, o anumang Celo-compatible wallet para matanggap ang G$ mo.",
    "More Ways To Earn": "Iba Pang Paraan para Kumita",

    # ── Join-community banner ──────────────────────────────────────────
    "🤝 Join the GoodMarket Community": "🤝 Sumali sa GoodMarket Community",
    "✈️ Join GoodMarket Community": "✈️ Sumali sa GoodMarket Community",
    "Connect with fellow G$ earners in our Telegram discussion group — community updates, tips, and support.":
        "Makipag-usap sa kapwa G$ earners sa aming Telegram discussion group — updates, tips, at suporta.",

    # ── Voucher ────────────────────────────────────────────────────────
    "GoodMarket Daily Reward": "Arawang Reward ng GoodMarket",
    "Voucher Available Now!": "May Voucher Ngayon!",
    "Available Now!": "Available Ngayon!",
    "🎟️ Claim GoodMarket Voucher": "🎟️ I-claim ang GoodMarket Voucher",
    "Voucher Claimed!": "Na-claim ang Voucher!",
    "Withdraw Reward": "I-withdraw ang Reward",

    # ── Face verification ──────────────────────────────────────────────
    "Face Verification": "Pagpapatunay ng Mukha",
    "Verify my account": "I-verify ang account ko",
    "Verify Now": "I-verify Ngayon",
    "Status": "Katayuan",
    "Last verified": "Huling na-verify",
    "Expires": "Mag-e-expire",
    "Time remaining": "Natitirang oras",
    "De-verify my account": "I-de-verify ang account ko",

    # ── GCash cashout ──────────────────────────────────────────────────
    "Full Name": "Buong Pangalan",
    "Refunded": "Naibalik",

    # ── Swap / bridge ──────────────────────────────────────────────────
    "Swap": "Mag-swap",
    "From": "Mula sa",
    "To": "Papunta sa",
    "You receive": "Matatanggap mo",
}

SPANISH = {
    # ── Navigation / shared chrome ─────────────────────────────────────
    "Settings": "Configuración",
    "Close": "Cerrar",
    "Cancel": "Cancelar",
    "Confirm": "Confirmar",
    "Continue": "Continuar",
    "Back": "Atrás",
    "Next": "Siguiente",
    "Save": "Guardar",
    "Loading…": "Cargando…",
    "Loading...": "Cargando...",
    "Processing, please wait…": "Procesando, espere por favor…",
    "Copy": "Copiar",
    "Copied!": "¡Copiado!",
    "Refresh": "Actualizar",
    "Retry": "Reintentar",
    "Submit": "Enviar",
    "Send": "Enviar",
    "Receive": "Recibir",
    "Earn": "Ganar",
    "More": "Más",
    "Wallet": "Cartera",
    "Dashboard": "Panel",
    "Language": "Idioma",
    "Logout": "Cerrar sesión",
    "Log in": "Iniciar sesión",
    "Username": "Nombre de usuario",
    "Transaction History": "Historial de transacciones",
    "No transactions yet": "Aún no hay transacciones",

    # ── Generic status / errors ────────────────────────────────────────
    "Success!": "¡Éxito!",
    "Failed": "Falló",
    "Pending": "Pendiente",
    "Completed": "Completado",
    "Claimed": "Reclamado",
    "Rejected": "Rechazado",
    "Approved": "Aprobado",
    "Insufficient balance": "Saldo insuficiente",
    "Insufficient gas": "Gas insuficiente",
    "Something went wrong": "Algo salió mal",
    "Please try again": "Inténtalo de nuevo",
    "Please try again.": "Inténtalo de nuevo.",
    "Network error": "Error de red",
    "Connection failed": "Conexión fallida",
    "Transaction failed": "Transacción fallida",
    "Sign this transaction": "Firma esta transacción",
    "Sign & Continue": "Firmar y continuar",
    "Signing…": "Firmando…",
    "Waiting for confirmation…": "Esperando confirmación…",

    # ── Wallet hub ─────────────────────────────────────────────────────
    "Claim G$": "Reclamar G$",
    "Claim G$ to My Wallet": "Reclamar G$ a mi cartera",
    "Claim UBI G$": "Reclamar UBI G$",
    "Claimable UBI": "UBI reclamable",
    "GoodMarket Portfolio": "Portafolio de GoodMarket",
    "Recipient Address": "Dirección del destinatario",
    "Amount": "Cantidad",
    "Amount to receive": "Cantidad a recibir",
    "Amount to claim": "Cantidad a reclamar",
    "Flow Rate": "Tasa de flujo",
    "For gas fees": "Para tarifas de gas",
    "Supported Tokens · Celo Network": "Tokens compatibles · Red Celo",
    "Supported Tokens · XDC Network": "Tokens compatibles · Red XDC",
    "Celo UBI Pool Balance": "Saldo del pool UBI de Celo",
    "Checking networks…": "Comprobando redes…",
    "Checking payment...": "Verificando pago...",
    "Wallet detected! Claim your G$ directly here.":
        "¡Cartera detectada! Reclama tus G$ aquí mismo.",
    "Preparing wallet connection...": "Preparando conexión de cartera...",
    "Waiting for wallet to connect...": "Esperando que la cartera se conecte...",
    "Your wallet will prompt you to confirm the transaction on the Celo network.":
        "Tu cartera te pedirá confirmar la transacción en la red Celo.",
    "Scan with MetaMask, TrustWallet, or any Celo-compatible wallet to receive your G$.":
        "Escanea con MetaMask, TrustWallet o cualquier cartera compatible con Celo para recibir tus G$.",
    "🤝 Referral": "🤝 Referidos",
    "More Ways To Earn": "Más formas de ganar",

    # ── Join-community banner ──────────────────────────────────────────
    "🤝 Join the GoodMarket Community": "🤝 Únete a la comunidad GoodMarket",
    "✈️ Join GoodMarket Community": "✈️ Unirse a la comunidad GoodMarket",
    "Connect with fellow G$ earners in our Telegram discussion group — community updates, tips, and support.":
        "Conecta con otros que ganan G$ en nuestro grupo de Telegram — novedades, consejos y soporte.",

    # ── Voucher ────────────────────────────────────────────────────────
    "GoodMarket Daily Reward": "Recompensa diaria de GoodMarket",
    "Voucher Available Now!": "¡Voucher disponible!",
    "Available Now!": "¡Disponible ahora!",
    "🎟️ Claim GoodMarket Voucher": "🎟️ Reclamar voucher de GoodMarket",
    "Voucher Claimed!": "¡Voucher reclamado!",
    "Withdraw Reward": "Retirar recompensa",

    # ── Face verification ──────────────────────────────────────────────
    "Face Verification": "Verificación facial",
    "Verify my account": "Verificar mi cuenta",
    "Verify Now": "Verificar ahora",
    "Status": "Estado",
    "Last verified": "Última verificación",
    "Expires": "Vence",
    "Time remaining": "Tiempo restante",
    "De-verify my account": "Desverificar mi cuenta",

    # ── GCash cashout ──────────────────────────────────────────────────
    "GCash Cashout": "Retiro por GCash",
    "Full Name": "Nombre completo",
    "Refunded": "Reembolsado",

    # ── Swap / bridge ──────────────────────────────────────────────────
    "Swap": "Intercambiar",
    "Bridge": "Puente",
    "From": "Desde",
    "To": "Hacia",
    "You receive": "Recibes",
}

# fmt: on

# Language code -> {english: translated}. Add a language by adding an entry
# here AND to i18n.SUPPORTED_LANGUAGES.
DICTIONARIES = {
    "fil": FILIPINO,
    "es": SPANISH,
}
