"""Render the wallet page with a given modal pre-opened, for theme QA."""
import os
import re
import sys

from jinja2 import Environment, FileSystemLoader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES = os.path.join(ROOT, "templates")
OUT = os.path.join(ROOT, ".agent_tmp", "render")


def _stub_url_for(endpoint, **values):
    if endpoint == "static":
        return "/static/" + str(values.get("filename", ""))
    return "/" + endpoint


MODALS = ["sendModal", "gcashModal", "settingsModal", "referralModal",
          "dailyTaskModal", "streamModal", "receiveModal", "claimModal", "fvIntroModal"]

env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=True)
env.globals["url_for"] = _stub_url_for

tmpl = env.get_template("wallet.html")
base = tmpl.render(
    wallet="0xAbCdEf1234567890AbCdEf1234567890AbCdEf12",
    login_method="local",
    gd_token_address="0x0000000000000000000000000000000000000000",
    raffle_contract_address="0x0000000000000000000000000000000000000000",
    walletconnect_project_id="demo",
    ASSET_VERSION="dev",
)

for modal in MODALS:
    # force the modal open by adding the `open` class (attribute order varies)
    pat = re.compile(r'(<div[^>]*\bid="' + modal + r'"[^>]*>)')

    def repl(m):
        tag = m.group(1)
        if 'class="' in tag:
            def add_open(cm):
                classes = cm.group(2).split()
                if "open" not in classes:
                    classes.append("open")
                return cm.group(1) + " ".join(classes) + '"'
            return re.sub(r'(class=")([^"]*)"', add_open, tag)
        return tag[:-1] + ' class="modal-overlay open">'

    html = pat.sub(repl, base)
    if html == base:
        print(f"  !! {modal}: NOT FOUND")
        continue
    with open(os.path.join(OUT, f"modal-{modal}.html"), "w", encoding="utf-8") as fh:
        fh.write(html)
    print(f"  wrote modal-{modal}.html")
