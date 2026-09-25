"""Render templates/swap.html with stubs to verify the extracted-bundle refactor
produces valid JS and the GM_SWAP_BOOT object holds every per-request value."""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from jinja2 import Environment, FileSystemLoader

env = Environment(loader=FileSystemLoader(os.path.join(ROOT, "templates")))
env.globals["url_for"] = lambda endpoint, **kw: "/static/" + kw.get("filename", "")
env.globals["ASSET_VERSION"] = "testver"

html = env.get_template("swap.html").render(
    wallet="0xABCDEF1234567890abcdef1234567890ABCDEF12",
    login_method="local",
    walletconnect_project_id="proj-123",
    walletconnect_sidecar_enabled=False,
    privy_app_id="",
    privy_client_id="",
    reserve_swap_visible=True,
    is_minipay=False,
    bridge_contract="0xa3247276DbCC76Dd7705273f766eB3E8a5ecF4a5",
    celo_gd_token_contract="0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A",
    xdc_gd_token_contract="0xEC2136843a983885AebF2feB3931F73A8eBEe50c",
    xdc_chain_id=50,
    celo_chain_id=42220,
    fuse_chain_id=122,
    fuse_rpc_url="https://rpc.fuse.io",
    fuse_gd_token_contract="0x495d133B938596C9984d462F007B676bDc57eCEC",
    fuse_gd_decimals=2,
    fuse_wfuse_contract="0x0BE9e53fd7EDaC9F859882AfdDa116645287C629",
    voltage_router_contract="0xE3F85aAd0c8DD7337427B9dF5d0fB741d65EEEB5",
)

# 1. all three bundles referenced
for name in ("swap-core.js", "swap-reserve.js", "swap-bridge.js"):
    assert name in html, name

# 2. no leftover Jinja
leftover = re.findall(r"\{\{.*?\}\}|\{%.*?%\}", html)
assert not leftover, f"leftover Jinja: {set(leftover)}"

# 3. GM_SWAP_BOOT is a valid JS object literal with every per-request value
m = re.search(r"window\.GM_SWAP_BOOT = (\{.*?\n        \});", html, re.S)
assert m, "GM_SWAP_BOOT not found"
boot_src = m.group(1)
boot_js = "/tmp/swap_boot_check.js"
open(boot_js, "w").write("globalThis.GM_SWAP_BOOT = %s;\nconsole.log(JSON.stringify(globalThis.GM_SWAP_BOOT));" % boot_src)
r = subprocess.run(["node", boot_js], capture_output=True, text=True)
assert r.returncode == 0, "GM_SWAP_BOOT is not valid JS:\n" + r.stderr
boot = json.loads(r.stdout)
assert boot["wallet"] == "0xABCDEF1234567890abcdef1234567890ABCDEF12"
assert boot["loginMethod"] == "local"
assert boot["walletConnectProjectId"] == "proj-123"
assert boot["assetVersion"] == "testver"
assert boot["fuseChainId"] == 122
assert boot["xdcChainId"] == 50
assert boot["celoChainId"] == 42220
assert boot["bridgeContract"] == "0xa3247276DbCC76Dd7705273f766eB3E8a5ecF4a5"
assert boot["celoGdTokenContract"].startswith("0x62B8")
assert boot["xdcGdTokenContract"].startswith("0xEC21")
assert boot["voltageRouter"].startswith("0xE3F8")
assert boot["wcBundleUrl"] == "/static/js/wc-bundle.js"

# 4. the boot object sits BEFORE the bundles that consume it
assert html.index("GM_SWAP_BOOT") < html.index("swap-core.js")

print("RAW HTML: OK (boot object + bundle refs + no Jinja leak)")

# 5. substituting the real boot values into the bundles must yield parseable JS
boot_js = "var window = {GM_SWAP_BOOT: %s};\n" % json.dumps(boot)
combined = boot_js + "\n".join(
    open(os.path.join(ROOT, b), encoding="utf-8").read()
    for b in ("static/js/swap-core.js", "static/js/swap-reserve.js", "static/js/swap-bridge.js")
)
tmp = "/tmp/swap_combined.js"
open(tmp, "w").write(combined)
r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
print("node --check combined:", "OK" if r.returncode == 0 else "FAIL\n" + r.stderr)
assert r.returncode == 0
print("ALL RENDER CHECKS PASSED")
