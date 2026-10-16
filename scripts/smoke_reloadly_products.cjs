/* Node harness: run the REAL store filter/render logic from reloadly.html.
 *
 * Extracts the product-filtering functions out of the template (stripping the
 * Jinja that only wraps other parts of the page) and drives them with a
 * realistic PH payload — Globe/TM airtime plus their bundle operators — to
 * prove that:
 *   - each operator is classified (airtime vs data/bundle),
 *   - the chips partition the list with correct counts,
 *   - the grid renders the FILTERED subset and selectOperator() indexes into
 *     that same list (the off-by-one that would otherwise open the wrong
 *     operator),
 *   - a chip with no matches falls back to "all".
 *
 * Exits non-zero on any assertion failure. Run: node scripts/smoke_reloadly_products.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const tpl = fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'reloadly.html'), 'utf8');

// Pull the whole inline script block that holds the topup logic.
const blocks = [...tpl.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const script = blocks.sort((a, b) => b.length - a.length)[0];

function fnBody(src, signature) {
  const idx = src.indexOf(signature);
  if (idx === -1) throw new Error('signature not found: ' + signature);
  // Slice FROM the signature (it is a valid function head, e.g. "function f(")
  // so the parameters are kept; the body ends at the next top-level decl.
  const rest = src.slice(idx);
  const after = rest.slice(signature.length);
  const marks = ['\nfunction ', '\nasync function ', '\nconst ', '\nlet ']
    .map(m => after.indexOf(m)).filter(p => p !== -1);
  return marks.length ? rest.slice(0, signature.length + Math.min(...marks)) : rest;
}

// Collect the functions under test plus the module-scope filter state.
const wanted = [
  'function operatorProductType(', 'function operatorIsDataBundle(',
  'function operatorTypeLabel(', 'function productFilterCounts(',
  'function applyProductFilter(', 'function renderProductFilterBar(',
  'function renderOperators(', 'function selectOperator(',
];
const collected = wanted.map(sig => fnBody(script, sig)).join('\n');

// Minimal DOM: record what renderOperators() writes and which card was clicked.
const state = { html: '', selectedIdx: null };
const els = {};
function makeEl(id) {
  return els[id] || (els[id] = {
    id, innerHTML: '', textContent: '', style: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    querySelectorAll: () => [], querySelector: () => null,
    getBoundingClientRect: () => ({ bottom: 0 }),
  });
}
const document = {
  getElementById: makeEl,
  querySelectorAll: () => [],
  querySelector: () => null,
};

const sandbox = {
  document, console,
  window: {},
  _operatorProductFilter: 'all',
  GD_PRICE: 0.0001,
  _operatorProductsCache: new Map(),
  PRODUCT_FILTER_LABELS: { all: 'All products', airtime: 'Airtime', data: 'Data & Bundles' },
};
sandbox.window = sandbox;
vm.createContext(sandbox);

// renderOperators() calls applyProductFilter + renderProductFilterBar, and the
// result is written to document.getElementById('operatorList').innerHTML.
vm.runInContext(`
let _operatorProductFilter = 'all';
let selectedOperator = null, selectedAmount = null;
const PRODUCT_FILTER_LABELS = { all: 'All products', airtime: 'Airtime', data: 'Data & Bundles' };
// Stubs for collaborators selectOperator() calls that are out of scope here
// (the amount chooser + the per-operator product fetch).
function renderOperatorAmounts() {}
function loadOperatorProducts() { return Promise.resolve(null); }
${collected}
this.__api = { renderOperators, selectOperator, setFilter: (f) => { _operatorProductFilter = f; }, getSelected: () => selectedOperator };
this.__getFilter = () => _operatorProductFilter;
`, sandbox);

const { renderOperators, selectOperator, setFilter } = sandbox.__api;

// Reloadly PH-style payload: airtime operators + their separate bundle operators.
const operators = [
  { id: 10, operatorId: 10, name: 'Globe Telecom', bundle: 0, data: 0, product_type: 'airtime', gd_amounts: [10000, 20000] },
  { id: 11, operatorId: 11, name: 'Globe Bundles', bundle: 1, data: 0, product_type: 'bundle', gd_amounts: [8300] },
  { id: 12, operatorId: 12, name: 'TM', bundle: 0, data: 0, product_type: 'airtime', gd_amounts: [10000] },
  { id: 13, operatorId: 13, name: 'TM Bundles', bundle: 1, data: 0, product_type: 'bundle', gd_amounts: [8300] },
  { id: 14, operatorId: 14, name: 'Smart Communications', bundle: 0, data: 0, product_type: 'airtime', gd_amounts: [10000] },
];

let failures = 0;
function check(name, cond, extra) {
  if (!cond) { failures++; console.error('FAIL:', name, extra === undefined ? '' : extra); }
  else console.log('ok  :', name);
}

// ── 1. "all" shows every operator, with both badges ─────────────────────────
setFilter('all');
renderOperators(operators, null, {});
let html = makeEl('operatorList').innerHTML;
check('all: renders every operator', (html.match(/operator-card/g) || []).length === 5);
check('all: filter bar shown when both kinds present', html.includes('product-filter-bar'));
check('all: counts partition the list', html.includes('Airtime (3)') && html.includes('Data & Bundles (2)'),
      html.match(/(Airtime|Data & Bundles) \(\d+\)/g));
check('all: bundle operator badged as data', html.includes('op-type-badge is-data'));
check('all: airtime operator badged', html.includes('>Airtime<'));

// ── 2. "airtime" shows only airtime, and indexes match ──────────────────────
setFilter('airtime');
renderOperators(operators, null, {});
html = makeEl('operatorList').innerHTML;
const airtimeCards = (html.match(/operator-card/g) || []).length;
check('airtime: only airtime operators', airtimeCards === 3, airtimeCards);
check('airtime: no bundle cards', !html.includes('TM Bundles'));

// selectOperator(1) must open the SECOND AIRTIME operator (TM), not TM Bundles.
selectOperator(1);
check('airtime: index maps to filtered list (TM)', sandbox.__api.getSelected()?.name === 'TM',
      sandbox.__api.getSelected()?.name);
check('airtime: bundle operator NOT selected at index 1', sandbox.__api.getSelected()?.name !== 'TM Bundles');

// ── 3. "data" shows only data/bundle operators ─────────────────────────────
setFilter('data');
renderOperators(operators, null, {});
html = makeEl('operatorList').innerHTML;
const dataCards = (html.match(/operator-card/g) || []).length;
check('data: only data/bundle operators', dataCards === 2, dataCards);
check('data: includes both bundle operators', html.includes('Globe Bundles') && html.includes('TM Bundles'));
selectOperator(0);
check('data: index 0 is a bundle operator', sandbox.__api.getSelected()?.name === 'Globe Bundles',
      sandbox.__api.getSelected()?.name);

// ── 4. A chip with no matches falls back to "all" ───────────────────────────
const airtimeOnly = operators.filter(o => o.product_type === 'airtime');
setFilter('data');
renderOperators(airtimeOnly, null, {});
html = makeEl('operatorList').innerHTML;
check('fallback: no empty grid when chip has no matches', (html.match(/operator-card/g) || []).length === 3);
check('fallback: filter bar hidden (only one kind)', !html.includes('product-filter-bar'));

// ── 5. Detection flag still surfaces ────────────────────────────────────────
setFilter('all');
renderOperators(operators, 13, {});
html = makeEl('operatorList').innerHTML;
check('detected: auto-detect banner kept', html.includes('Auto-detected from phone number'));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll store product-filter checks passed.');
process.exit(0);
