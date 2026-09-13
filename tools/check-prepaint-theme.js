// Extracts the real pre-paint script out of index.html and runs it against every
// (saved theme x OS preference) combination. This is the code that decides the
// status bar before first paint, so a flash or a wrong bar on load originates here.
const fs = require('fs');
const path = require('path');
const file = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(file, 'utf8');

const m = html.match(/<script>\s*(\(function \(\) \{[\s\S]*?\})\)\(\);\s*<\/script>/);
if (!m) { console.error('FAIL: pre-paint script not found in ' + file); process.exit(1); }
const body = m[1] + ')();';

const DARK = '#0a0f1e', LIGHT = '#dbe4f2';
const cases = [
  { saved: null,    osDark: false, want: LIGHT, why: 'System on light OS' },
  { saved: null,    osDark: true,  want: DARK,  why: 'System on dark OS' },
  { saved: 'light', osDark: false, want: LIGHT, why: 'manual Light, light OS' },
  { saved: 'light', osDark: true,  want: LIGHT, why: 'manual Light beats dark OS' },
  { saved: 'dark',  osDark: false, want: DARK,  why: 'manual Dark beats light OS' },
  { saved: 'dark',  osDark: true,  want: DARK,  why: 'manual Dark, dark OS' },
];

const fails = [];
for (const c of cases) {
  const meta = { content: '(unset)', setAttribute(k, v) { if (k === 'content') this.content = v; } };
  const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const sandbox = {
    localStorage: { getItem: k => (k === 'cpd.theme' ? c.saved : null) },
    document: { documentElement: root, querySelector: () => meta },
    window: { matchMedia: q => ({ matches: /dark/.test(q) ? c.osDark : !c.osDark }) },
  };
  sandbox.window.localStorage = sandbox.localStorage;
  // A malformed or partially-extracted script must be reported as "did not run",
  // not surface as a raw stack trace that is hard to tell from a real failure.
  let fn;
  try {
    fn = new Function('localStorage', 'document', 'window', body);
  } catch (e) {
    console.error('FAIL: pre-paint script did not run - ' + e.name + ': ' + e.message);
    console.error('  (the script could not be parsed; this is NOT a clean result)');
    process.exit(2);
  }
  try {
    fn(sandbox.localStorage, sandbox.document, sandbox.window);
  } catch (e) {
    fails.push(`${c.why}: script threw ${e.name}: ${e.message}`);
    continue;
  }
  const got = meta.content.toLowerCase();
  const expectedAttr = c.saved === 'light' || c.saved === 'dark' ? c.saved : undefined;
  if (got !== c.want.toLowerCase()) fails.push(`${c.why}: meta ${got}, expected ${c.want}`);
  if (root.attrs['data-theme'] !== expectedAttr)
    fails.push(`${c.why}: data-theme ${root.attrs['data-theme']}, expected ${expectedAttr}`);
}

if (fails.length) { console.error('FAIL: pre-paint theme resolution'); fails.forEach(f => console.error('  ' + f)); process.exit(1); }
console.log(`OK: pre-paint script correct for all ${cases.length} theme x OS combinations`);
