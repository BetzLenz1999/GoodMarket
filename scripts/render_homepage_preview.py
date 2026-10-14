"""Render templates/homepage.html standalone so a browser can screenshot it.

Stubs out the Jinja context the real route supplies, plus url_for/includes,
so the "Deep Indigo" theme rework and the Get Started reminder panel can be
eyeballed before shipping. Output goes to .agent_tmp/render/ (gitignored).

Usage:
    python scripts/render_homepage_preview.py
"""
import os
import sys

from jinja2 import Environment, FileSystemLoader

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

    tmpl = env.get_template("homepage.html")
    html = tmpl.render(
        request=None,
        ASSET_VERSION="dev",
        wallet="",
        login_method="",
        walletconnect_project_id="demo",
        walletconnect_sidecar_enabled=True,
        enable_privy_login=False,
        privy_app_id="",
        privy_client_id="",
        google_client_id="",
        homepage_stats={
            "total_g_disbursed_formatted": "1.45M G$",
            "total_g_disbursed_usd_formatted": "2,900",
            "gd_usd_price": 0.002,
            "total_g_disbursed_week_growth_pct": 4.2,
            "active_earners_formatted": "18,204",
            "tasks_last_30_days_formatted": "6,731",
        },
        pwa_installable=True,
    )
    out = os.path.join(OUT, "homepage.html")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("wrote", out, len(html), "bytes")


if __name__ == "__main__":
    main()
