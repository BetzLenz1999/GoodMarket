"""Server-side resolution of the /swap deep-link tab state.

``/swap`` has two top-level tabs (GoodSwap, Bridge) with sub-tabs under each.
The client-side ``autoSelectSwapTab()`` (static/js/swap-reserve.js) used to be
the ONLY thing that decided which tab a ``?tab=`` / ``?pane=`` / ``?dir=`` deep
link should focus — but that bundle loads near the end of ``<body>``, so the
server always painted GoodSwap first and the user watched it flash/switch to
Bridge (or, if the bundle failed to load, stay wrong permanently).

Resolving the initial state here (and rendering it into the HTML) makes the
correct pane the one that arrives, so the client logic only matters for hash
links (``#bridge``), which the browser never sends to the server.

Dependency-free so it can be unit-tested and imported by routes.py.
"""

# These alias tables MUST stay in sync with autoSelectSwapTab() in
# static/js/swap-reserve.js. A parity test pins the two together.
BRIDGE_TAB_ALIASES = ("bridge", "xdc", "bridge-xdc")
GOODSWAP_TAB_ALIASES = ("goodswap", "swap")
RESERVE_TAB_ALIASES = ("reserve", "goodreserve")
DEX_TAB_ALIASES = ("dex", "uniswap", "uniswapv3", "uniswap-v3", "uniswap_v3")
FUSE_TAB_ALIASES = ("fuse", "fuse-swap", "fuseswap", "voltage")
XDC_TO_CELO_DIR_ALIASES = ("xdc_to_celo", "xdc-to-celo", "xdctocelo")
CELO_TO_XDC_DIR_ALIASES = ("celo_to_xdc", "celo-to-xdc", "celotoxdc")
CELO_TO_BASE_DIR_ALIASES = ("celo_to_base", "celo-to-base", "celotobase")


def resolve_swap_tab_state(args):
    """Map ?tab= / ?pane= / ?dir= to the server-rendered initial tab state.

    ``args`` is any mapping with ``.get`` (a Flask ``request.args`` or a plain
    dict). Returns ``{tab, goodswap_pane, bridge_dir, focused}``:

    * ``tab``           — ``"goodswap"`` or ``"bridge"``
    * ``goodswap_pane`` — ``"dex"`` or ``"reserve"``
    * ``bridge_dir``    — ``"celo_to_xdc"`` / ``"xdc_to_celo"`` /
                          ``"celo_to_base"`` (or ``None`` when no dir was given)
    * ``focused``       — True when the URL explicitly named a section, so the
                          top-level [GoodSwap | Bridge] switcher is hidden (the
                          same "focused mode" the client applies).

    The caller is responsible for falling back when a requested pane is not
    rendered for that request (GoodReserve hidden by feature flag, Celo→Base
    with LI.FI disabled) — see routes.py::swap_page().
    """
    want = (args.get("tab") or "").strip().lower()
    pane = (args.get("pane") or "").strip().lower()
    dir_raw = (args.get("dir") or "").strip().lower()

    tab = "goodswap"
    goodswap_pane = "dex"
    bridge_dir = None

    if want in BRIDGE_TAB_ALIASES:
        tab = "bridge"
    elif want in GOODSWAP_TAB_ALIASES:
        tab = "goodswap"
    elif want in RESERVE_TAB_ALIASES:
        goodswap_pane = "reserve"
    elif want in DEX_TAB_ALIASES or want in FUSE_TAB_ALIASES:
        # The Fuse sub-pane is not shipped; both aliases land on Dex, matching
        # setGoodSwapSubTab() which maps "fuse" -> "dex".
        goodswap_pane = "dex"

    pane_recognized = False
    if pane in RESERVE_TAB_ALIASES:
        goodswap_pane = "reserve"
        pane_recognized = True
    elif pane in DEX_TAB_ALIASES or pane in FUSE_TAB_ALIASES:
        goodswap_pane = "dex"
        pane_recognized = True

    if dir_raw in XDC_TO_CELO_DIR_ALIASES:
        bridge_dir = "xdc_to_celo"
    elif dir_raw in CELO_TO_XDC_DIR_ALIASES:
        bridge_dir = "celo_to_xdc"
    elif dir_raw in CELO_TO_BASE_DIR_ALIASES:
        bridge_dir = "celo_to_base"

    # Mirror the client's focus rule exactly:
    #   focusBridge   = target === "bridge" || !!bridgeDir
    #   focusGoodSwap = !focusBridge && (target === "goodswap" || !!goodswapPane)
    # An unrecognized ?tab=/?pane= leaves target/pane unset, so the client
    # returns early without focusing — match that (unknown params => not focused).
    tab_recognized = want in (
        BRIDGE_TAB_ALIASES + GOODSWAP_TAB_ALIASES
        + RESERVE_TAB_ALIASES + DEX_TAB_ALIASES + FUSE_TAB_ALIASES
    )
    focus_bridge = tab == "bridge" or bool(bridge_dir)
    focus_goodswap = (not focus_bridge) and (tab_recognized or pane_recognized)
    return {
        "tab": tab,
        "goodswap_pane": goodswap_pane,
        "bridge_dir": bridge_dir,
        "focused": focus_bridge or focus_goodswap,
    }
