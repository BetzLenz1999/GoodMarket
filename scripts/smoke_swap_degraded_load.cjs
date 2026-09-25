// Regression test for the cross-bundle guard: if swap-bridge.js fails to load
// (network error, stale cache, CDN hiccup), setSwapTab('bridge') must STILL
// switch the tab instead of aborting on a ReferenceError.
const fs = require('fs');
const vm = require('vm');

function el() {
  const cls = new Set();
  return {
    style: {}, disabled: false, innerHTML: '', textContent: '', value: '',
    classList: {
      add(c) { cls.add(c); }, remove(c) { cls.delete(c); },
      toggle(c, on) { on ? cls.add(c) : cls.delete(c); }, contains(c) { return cls.has(c); },
    },
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {},
    appendChild() {}, remove() {}, focus() {}, querySelector() { return null; },
    _cls: cls,
  };
}

const panes = {};
for (const id of ['swapPaneGoodSwap', 'swapPaneBridge']) panes[id] = el();
const btns = {};
for (const id of ['tabBtnGoodSwap', 'tabBtnBridge']) btns[id] = el();

global.window = global;
global.GM_SWAP_BOOT = JSON.parse(process.argv[2]);
global.addEventListener = function () {};
global.document = {
  readyState: 'complete',
  addEventListener() {}, removeEventListener() {},
  getElementById(id) { return panes[id] || btns[id] || null; },
  querySelector(sel) {
    if (sel === '.pane-goodswap') return panes.swapPaneGoodSwap;
    if (sel === '.pane-bridge') return panes.swapPaneBridge;
    return null;
  },
  querySelectorAll() { return []; }, createElement() { return el(); },
  head: el(), body: el(), documentElement: el(),
};
global.location = { origin: 'https://x.test', search: '', hash: '', href: 'https://x.test/swap' };
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
global.sessionStorage = global.localStorage;
global.navigator = { userAgent: 'node' };
global.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
global.ethers = { BrowserProvider: function () {}, JsonRpcProvider: function () {}, Contract: function () {} };

// Load ONLY core + reserve — simulate swap-bridge.js failing to load.
for (const f of ['static/js/swap-core.js', 'static/js/swap-reserve.js']) {
  vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: f });
}

if (typeof global.updateCeloBridgeBalanceDisplay !== 'undefined') {
  console.error('precondition failed: bridge bundle appears loaded');
  process.exit(1);
}

// This is the call that used to throw.
global.setSwapTab('bridge');

const okBridge = panes.swapPaneBridge._cls.has('hidden-tab') === false;
const hiddenGood = panes.swapPaneGoodSwap._cls.has('hidden-tab') === true;
const btnActive = btns.tabBtnBridge._cls.has('active') === true;

if (!okBridge || !hiddenGood || !btnActive) {
  console.error('tab did NOT switch with bridge bundle missing:',
    { bridgeVisible: okBridge, goodswapHidden: hiddenGood, bridgeBtnActive: btnActive });
  process.exit(1);
}

console.log('DEGRADED-LOAD TEST PASSED (bridge tab still switches without swap-bridge.js)');
