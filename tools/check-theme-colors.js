// The two status-bar colours appear in index.html (initial tag + pre-paint
// script), app.js (THEME_BG) and manifest.webmanifest. Drift between them is
// silent: the app looks right and the status bar quietly contradicts it.
// This fails the build if they disagree.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const html = read('index.html');
const app = read('app.js');
const manifest = JSON.parse(read('manifest.webmanifest'));

const fail = [];
const inlineDark = (html.match(/DARK\s*=\s*'(#[0-9a-fA-F]{6})'/) || [])[1];
const inlineLight = (html.match(/LIGHT\s*=\s*'(#[0-9a-fA-F]{6})'/) || [])[1];
const appDark = (app.match(/THEME_BG\s*=\s*\{\s*dark:\s*'(#[0-9a-fA-F]{6})'/) || [])[1];
const appLight = (app.match(/THEME_BG\s*=\s*\{[^}]*light:\s*'(#[0-9a-fA-F]{6})'/) || [])[1];

const tags = html.match(/<meta\s+name="theme-color"[^>]*>/g) || [];
if (tags.length !== 1) fail.push(`expected exactly 1 theme-color tag, found ${tags.length}`);
const tagColor = (tags[0] || '').match(/content="(#[0-9a-fA-F]{6})"/);

if (!inlineDark || !inlineLight) fail.push('pre-paint script colours not found in index.html');
if (!appDark || !appLight) fail.push('THEME_BG not found in app.js');
if (inlineDark && appDark && inlineDark.toLowerCase() !== appDark.toLowerCase())
  fail.push(`dark drift: index.html=${inlineDark} app.js=${appDark}`);
if (inlineLight && appLight && inlineLight.toLowerCase() !== appLight.toLowerCase())
  fail.push(`light drift: index.html=${inlineLight} app.js=${appLight}`);
if (tagColor && inlineLight && tagColor[1].toLowerCase() !== inlineLight.toLowerCase())
  fail.push(`tag default ${tagColor[1]} does not match the light colour ${inlineLight}`);
// An installed Android PWA takes its status bar from the manifest, not from the
// runtime meta tag, and theme_color is a single static value with no media-query
// equivalent - so it cannot track the in-app Day/Night toggle. It is pinned to
// the DARK colour deliberately: that is the mode where a mismatch is glaring (a
// white band above a dark app), and white-on-dark stays readable in Day mode.
// Pinned here so the choice cannot be silently reverted.
if (manifest.theme_color && inlineDark &&
    manifest.theme_color.toLowerCase() !== inlineDark.toLowerCase())
  fail.push(`manifest theme_color=${manifest.theme_color} must be the dark value ${inlineDark} (installed PWA uses this, not the meta tag)`);
if (manifest.background_color && inlineDark &&
    manifest.background_color.toLowerCase() !== inlineDark.toLowerCase())
  fail.push(`manifest background_color=${manifest.background_color} should match the dark splash ${inlineDark}`);

if (fail.length) { console.error('FAIL: theme colour inconsistency'); fail.forEach(f => console.error('  ' + f)); process.exit(1); }
console.log(`OK: theme colours agree (dark ${appDark}, light ${appLight}), exactly 1 theme-color tag`);
