"""Render templates/wallet.html standalone so a browser can screenshot it.

Stubs out the Jinja context the real route supplies, plus url_for/includes.
Used only for visual QA during the theme rework.
"""
import os
import re
import sys

from jinja2 import Environment, FileSystemLoader, ChoiceLoader, DictLoader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES = os.path.join(ROOT, "templates")
sys.path.insert(0, ROOT)

OUT = os.path.join(ROOT, ".agent_tmp", "render")
os.makedirs(OUT, exist_ok=True)


def _stub_url_for(endpoint, **values):
    if endpoint == "static":
        return "/static/" + str(values.get("filename", ""))
    return "/" + endpoint


def main():
    env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=True)
    env.globals["url_for"] = _stub_url_for
    # The real page includes these; render them as empty so the layout is visible.
    for name in ("_security_banner.html", "_claim_celebration.html", "_ai_agent.html"):
        path = os.path.join(TEMPLATES, name)
        if not os.path.exists(path):
            env.loader = ChoiceLoader([env.loader, DictLoader({name: ""})])

    tmpl = env.get_template("wallet.html")
    html = tmpl.render(
        wallet="0xAbCdEf1234567890AbCdEf1234567890AbCdEf12",
        login_method="local",
        gd_token_address="0x0000000000000000000000000000000000000000",
        raffle_contract_address="0x0000000000000000000000000000000000000000",
        walletconnect_project_id="demo",
        ASSET_VERSION="dev",
    )
    out = os.path.join(OUT, "wallet.html")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("wrote", out, len(html), "bytes")


if __name__ == "__main__":
    main()
