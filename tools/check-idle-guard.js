// Any mutation of the audio element outside the functions that own its state
// must be guarded by a state.onSilence check. Idle loops the last clip at
// volume 0; an unguarded write there replays that transmission out loud.
const fs = require('fs');
const path = process.argv[2] || require('path').join(__dirname, '..', 'app.js');
const src = fs.readFileSync(path, 'utf8').split('\n');
const owners = ['playSilence', 'playCall', 'ensureAudio', 'emergencyStop', 'ensureKeepAlive', 'stop', 'tryResume'];
let current = null; const bad = [];
src.forEach((line, i) => {
  const fn = line.match(/^function\s+([A-Za-z0-9_]+)/);
  if (fn) current = fn[1];
  if (!/\baudio\.(volume|src|loop|muted|currentTime|playbackRate)\s*=/.test(line)) return;
  if (owners.includes(current)) return;
  if (/onSilence/.test(src.slice(Math.max(0, i - 2), i + 1).join(' '))) return;
  bad.push(`line ${i + 1} in ${current || '(top level)'}: ${line.trim()}`);
});
if (bad.length) { console.error('FAIL: ' + bad.length + ' unguarded idle-state mutation(s)'); bad.forEach(b => console.error('  ' + b)); process.exit(1); }
console.log('OK: no unguarded audio mutations outside the owning functions');
