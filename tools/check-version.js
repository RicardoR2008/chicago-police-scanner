// Guards the rule that app.js's visible build tag and the service worker's cache
// name always move together. Run before committing any app change:
//     node tools/check-version.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

const appMatch = app.match(/APP_VERSION\s*=\s*'([^']+)'/);
const swMatch = sw.match(/CACHE\s*=\s*'cpd-scanner-([^']+)'/);

if (!appMatch) { console.error('FAIL: APP_VERSION not found in app.js'); process.exit(1); }
if (!swMatch) { console.error('FAIL: CACHE not found in sw.js'); process.exit(1); }

const [, appVersion] = appMatch;
const [, swVersion] = swMatch;

if (appVersion !== swVersion) {
  console.error(`FAIL: version mismatch - app.js=${appVersion} sw.js=cpd-scanner-${swVersion}`);
  console.error('Bump both together so the build tag reflects the deployed worker.');
  process.exit(1);
}

console.log(`OK: build ${appVersion} (app.js and sw.js agree)`);
