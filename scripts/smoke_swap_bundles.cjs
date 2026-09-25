// Runtime smoke test: execute the concatenated swap bundles under DOM stubs
// to catch any load-time throw introduced by the extraction (undefined
// identifiers, wrong boot keys, etc.). Not a DOM emulator — just enough that
// top-level evaluation completes.
const fs = require('fs');

const boot = JSON.parse(process.argv[2]);

function el() {
  return {
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {},
    appendChild() {}, remove() {}, focus() {}, querySelector() { return null; },
    innerHTML: '', textContent: '', value: '', disabled: false,
  };
}

global.window = global;
global.GM_SWAP_BOOT = boot;
global.addEventListener = function () {};
global.removeEventListener = function () {};
global.document = {
  readyState: 'complete',
  addEventListener() {}, removeEventListener() {},
  getElementById() { return null; }, querySelector() { return null; },
  querySelectorAll() { return []; }, createElement() { return el(); },
  head: el(), body: el(), documentElement: el(),
};
global.location = { origin: 'https://example.test', search: '', hash: '', href: 'https://example.test/swap' };
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
global.sessionStorage = global.localStorage;
global.navigator = { userAgent: 'node', language: 'en' };
global.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
global.ethers = {
  BrowserProvider: function () {}, JsonRpcProvider: function () {},
  Contract: function () {}, Interface: function () { return { encodeFunctionData: () => '0x' }; },
  parseUnits: () => 0n, formatUnits: () => '0', getAddress: (a) => a,
  Wallet: function () {}, utils: {},
};
global.GMWalletConnect = undefined;
global.GMLocalWallet = undefined;

const files = ['static/js/swap-core.js', 'static/js/swap-reserve.js', 'static/js/swap-bridge.js'];
const src = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');

// Run through the VM so a throw is reported with the file context.
const vm = require('vm');
try {
  vm.runInThisContext(src, { filename: 'swap-bundles.js' });
} catch (e) {
  console.error('LOAD-TIME THROW:', e.message);
  process.exit(1);
}

// Key entry points must exist after evaluation.
const required = [
  'startSwap', 'startReserveSwap', 'startFuseSwap', 'fetchQuote', 'fetchReserveQuote',
  'getConnectedSwapSigner', 'setSwapTab', 'setGoodSwapSubTab', 'setBridgeSubTab',
  'bridgeCeloToXdc', 'bridgeXdcToCelo', 'estimateBridgeFeeCeloToXdc',
  'updateCeloBridgeBalanceDisplay', '_prewarmXdcBridgeTab',
  '_checkCeloDestinationBridge', '_warmUpXdcWalletProvider',
];
const missing = required.filter(n => typeof global[n] !== 'function');
if (missing.length) {
  console.error('MISSING GLOBALS:', missing.join(', '));
  process.exit(1);
}

// The lazy pre-warm must NOT have run at load time.
if (global._xdcBridgePrewarmed === true) {
  console.error('bridge pre-warm fired at page load');
  process.exit(1);
}

// Calling the tab open must trigger it once.
let calls = 0;
const realLoadGd = global.loadXdcGdBalance;
global.loadXdcGdBalance = function () { calls++; return realLoadGd.apply(this, arguments); };
global._prewarmXdcBridgeTab();
global._prewarmXdcBridgeTab();
if (calls !== 1) {
  console.error('pre-warm should run exactly once, ran', calls);
  process.exit(1);
}

console.log('RUNTIME SMOKE TEST PASSED (' + required.length + ' entry points)');
