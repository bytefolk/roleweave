// WCAG contrast audit for index.html.
//
//   node scripts/contrast-check.js [path/to/index.html]
//
// Tokens are parsed out of the stylesheet rather than restated here, so this
// cannot silently drift from the file it is checking. Every pair below is a
// combination the page actually renders; add a row whenever a new one appears.
// Exits 1 if any pair is below its threshold.
//
// Method: OKLCH -> linear sRGB -> WCAG relative luminance -> contrast ratio.
// Thresholds: 4.5:1 for text under 18.66px bold / 24px regular, 3:1 above it
// and for non-text UI boundaries.
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(FILE, 'utf8');

function oklchToLinearSrgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = L / 100;
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
  const L3 = l_ ** 3, M3 = m_ ** 3, S3 = s_ ** 3;
  return [
    +4.0767416621 * L3 - 3.3077115913 * M3 + 0.2309699292 * S3,
    -1.2684380046 * L3 + 2.6097574011 * M3 - 0.3413193965 * S3,
    -0.0041960863 * L3 - 0.7034186147 * M3 + 1.7076147010 * S3,
  ];
}

function luminance(spec) {
  let lin;
  if (typeof spec === 'string') {
    const h = spec.replace('#', '');
    lin = [0, 2, 4]
      .map(i => parseInt(h.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  } else {
    lin = oklchToLinearSrgb(spec[0], spec[1], spec[2]).map(v => Math.max(0, v));
  }
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ratio(fg, bg) {
  const a = luminance(fg), b = luminance(bg);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

// Parse one declaration block's custom properties.
function tokensFrom(selector) {
  const at = src.indexOf(selector);
  if (at === -1) throw new Error(`selector not found in ${FILE}: ${selector}`);
  const block = src.slice(at, src.indexOf('}', at));
  const out = {};
  const oklch = /--([a-z0-9-]+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g;
  const hex = /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g;
  let m;
  while ((m = oklch.exec(block))) out[m[1]] = [parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
  while ((m = hex.exec(block))) out[m[1]] = m[2];
  return out;
}

const light = tokensFrom(':root {');
const dark = tokensFrom(':root[data-theme="dark"] {');
// oklch(100% 0 0) has no hue component to match, so seed it explicitly.
if (!light.card) light.card = [100, 0, 0];

const SMALL = 4.5;
// Large-scale text (>= 24px regular / 18.66px bold) only needs 3:1.
const LARGE = 3;
const PAIRS = [
  ['nav + body text        ink-2 on paper', 'ink-2', 'paper', SMALL],
  ['headings               ink on paper', 'ink', 'paper', SMALL],
  ['section eyebrow        brand on paper', 'brand', 'paper', SMALL],
  ['section eyebrow        brand on band', 'brand', 'band', SMALL],
  ['cap rows / tab label   ink-2 on band', 'ink-2', 'band', SMALL],
  ['tier body              ink-2 on card', 'ink-2', 'card', SMALL],
  ['tier status            brand on card', 'brand', 'card', SMALL],
  ['shipped state          brand on band', 'brand', 'band', SMALL],
  ['float head live        brand on card', 'brand', 'card', SMALL],
  ['orbit node label       ink on card', 'ink', 'card', SMALL],
  ['hero meta / caption    ink-3 on paper', 'ink-3', 'paper', SMALL],
  ['caption on band        ink-3 on band', 'ink-3', 'band', SMALL],
  ['tier mind / node tag   ink-3 on card', 'ink-3', 'card', SMALL],
  ['building state         amber on band', 'amber', 'band', SMALL],
  ['primary button label   brand-ink on brand', 'brand-ink', 'brand', SMALL],
  ['selected tab label     brand-ink on brand', 'brand-ink', 'brand', SMALL],
  ['orbit centre label     brand-ink on brand', 'brand-ink', 'brand', SMALL],
  ['cta band body          brand-ink on brand', 'brand-ink', 'brand', SMALL],
  ['cta button label       brand on brand-ink', 'brand', 'brand-ink', SMALL],
  ['eyebrow pill           brand on brand-soft', 'brand', 'brand-soft', SMALL],
  ['inline code            brand on band', 'brand', 'band', SMALL],
  ['download menu hover   ink on band', 'ink', 'band', SMALL],
  ['hero headline accent  azure on paper', 'azure', 'paper', LARGE],
  ['primary button hover   brand-ink on brand-hover', 'brand-ink', 'brand-hover', SMALL],
];

let failed = 0;
let checked = 0;

for (const [themeName, T] of [['LIGHT', light], ['DARK', dark]]) {
  console.log(`\n${themeName}`);
  console.log('-'.repeat(72));
  for (const [label, fg, bg, need] of PAIRS) {
    if (!(fg in T)) { console.log(`  MISSING TOKEN --${fg} in ${themeName}`); failed++; continue; }
    if (!(bg in T)) { console.log(`  MISSING TOKEN --${bg} in ${themeName}`); failed++; continue; }
    const r = ratio(T[fg], T[bg]);
    const ok = r >= need;
    checked++;
    if (!ok) failed++;
    console.log(`  ${label.padEnd(46)} ${r.toFixed(2).padStart(5)}:1  need ${need}  ${ok ? 'PASS' : 'FAIL'}`);
  }
}

console.log(`\nCHECKED=${checked} FAILED=${failed}`);
if (failed) {
  console.log('RESULT=FAIL');
  process.exitCode = 1;
} else {
  console.log('RESULT=PASS');
}
