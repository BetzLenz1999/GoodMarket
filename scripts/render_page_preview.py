"""Render any template standalone for responsive QA measurement.

Stubs the Jinja context, url_for and includes so a real browser can measure the
page at several viewports. Output goes to .agent_tmp/render/ (gitignored).

Usage:
    python scripts/render_page_preview.py swap savings dashboard lotto
"""
import os
import sys

from jinja2 import ChainableUndefined, ChoiceLoader, DictLoader, Environment, FileSystemLoader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES = os.path.join(ROOT, "templates")
sys.path.insert(0, ROOT)

OUT = os.path.join(ROOT, ".agent_tmp", "render")
os.makedirs(OUT, exist_ok=True)

# Includes the pages reference; rendered empty so the layout is still visible.
EMPTY_INCLUDES = [
    "_security_banner.html", "_claim_celebration.html", "_ai_agent.html",
    "_chatroom.html", "_wallet_guide_banner.html", "_savings_intro_banner.html",
    "_get_started_modal.html", "_guest_connect_card.html", "_swap_connect_card.html",
    "_chatroom_tip_modal.html",
]

# Permissive defaults: any template var the real route supplies resolves to a
# harmless value instead of raising UndefinedError.
CTX = {
    "wallet": "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12",
    "login_method": "local",
    "is_guest": False,
    "gd_token_address": "0x0000000000000000000000000000000000000000",
    "raffle_contract_address": "0x0000000000000000000000000000000000000000",
    "walletconnect_project_id": "demo",
    "ASSET_VERSION": "dev",


    "get_flashed_messages": lambda *a, **k: [],
    "csrf_token": lambda: "stub",
    "goodmarket_agent_visible": True,
    "chatroom_visible": True,
    "dapp_connect_visible": True,
    "pwa_installable": True,
    "lifi_bridge_enabled": True,
    "swap_tab": None,
    "swap_goodswap_pane": None,
    "swap_bridge_dir": None,
    "swap_focused": False,
    "celo_rpc": "https://forno.celo.org",
    "celo_rpc_fallbacks": "",
    "gd_price": 0.000123,
    "farming_config": {
        "min_farm_gd": 1000, "chicken_price_gd": 100, "min_chickens": 10,
        "eggs_per_chicken_per_day": 1, "farm_days": 30,
        "monthly_profit_bps": 1000, "monthly_profit_percent": 10,
        "min_withdraw_gd": 500,
    },
    "fuse_chain_id": 122, "xdc_chain_id": 50, "celo_chain_id": 42220,
    "lifi_base_chain_id": 8453, "lifi_source_tokens": [],
    "bridge_contract": "0x0000000000000000000000000000000000000000",
    "celo_gd_token_contract": "0x0000000000000000000000000000000000000000",
    "xdc_gd_token_contract": "0x0000000000000000000000000000000000000000",
    "features": {},
    "homepage_stats": {},
    "balance": 0,
    "username": "tester",
    "user": {},
    "user_data": {},
    "stats": {},
    "config": {},
    "wallet_connect_project_id": "demo",
}


def _stub_url_for(endpoint, **values):
    if endpoint == "static":
        return "/static/" + str(values.get("filename", ""))
    if values:
        qs = "&".join(f"{k}={v}" for k, v in values.items())
        return f"/{endpoint}?{qs}"
    return "/" + endpoint


def build_env():
    env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=True,
                      undefined=ChainableUndefined)
    env.globals["url_for"] = _stub_url_for
    env.globals["get_flashed_messages"] = lambda *a, **k: []
    env.globals["csrf_token"] = lambda: "stub"
    missing = {n: "" for n in EMPTY_INCLUDES
               if not os.path.exists(os.path.join(TEMPLATES, n))}
    if missing:
        env.loader = ChoiceLoader([env.loader, DictLoader(missing)])
    return env


def render(name):
    env = build_env()
    tmpl = env.get_template(f"{name}.html")
    return tmpl.render(**CTX)


def main():
    names = sys.argv[1:] or ["swap", "savings", "dashboard", "lotto", "farming",
                             "xdc_wallet", "minigames", "claim"]
    for name in names:
        try:
            html = render(name)
        except Exception as exc:  # noqa: BLE001 - QA helper
            print(f"!! {name}: {type(exc).__name__}: {exc}")
            continue
        path = os.path.join(OUT, f"{name}.html")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(html)
        print(f"wrote {path} {len(html)} bytes")


if __name__ == "__main__":
    main()
