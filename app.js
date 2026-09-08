/* Chicago Police Scanner - a PWA that streams chi_cpd calls from OpenMHz.
 *
 * Two constraints drive the whole design:
 *   1. OpenMHz audio files send no CORS header, so the clips can only be played
 *      through a plain <audio> element. fetch()/Web Audio decoding is impossible.
 *   2. Audio has to survive the screen locking. Mobile browsers only keep a page
 *      alive in the background while a media element is actively producing sound,
 *      and iOS only allows programmatic play() on an element that a user gesture
 *      already unlocked.
 *
 * So: ONE <audio> element for the whole session, unlocked by the first tap and
 * never replaced, plus a SECOND element that plays a continuous keep-alive tone.
 *
 * The keep-alive matters more than it looks. Chrome only protects a backgrounded
 * page while it measures the page as audibly playing, at roughly -60 dBFS. The
 * original keep-alive was +/-1 LSB - measured at -91.4 dBFS, thirty decibels
 * below that line - so the page was frozen a few seconds after the screen locked
 * and playback stopped until the app was reopened. The tone is now 18 Hz at
 * -34 dBFS: subsonic, so a phone speaker cannot reproduce it, but unambiguously
 * not silence. It runs on its own element that never stops and never changes
 * src, so neither going idle nor swapping clips can interrupt the protection.
 */

// Shown at the bottom of the app. MUST match CACHE in sw.js - bump both together
// on every change, so the running build is verifiable by eye instead of assumed.
const APP_VERSION = 'v16';

const SYSTEM = 'chi_cpd';
const API = 'https://api.openmhz.com';
const POLL_MS = 5000;
// Calls also trigger a refill when they end, and during busy traffic that alone
// fired every ~1s. Floor the gap so the two triggers together stay polite -
// OpenMHz sits behind Cloudflare and will start challenging a chatty client.
const POLL_MIN_GAP_MS = 3000;
const START_LOOKBACK_MS = 20000;   // begin near-live rather than replaying history
const STALE_RESUME_MS = 60000;     // past this, a resume rejoins live instead of catching up

// Audio-focus recovery. Android pauses our element both for a passing chime and
// for another app taking the speaker for good, and gives us no way to tell which.
// So we judge by outcome: try to resume, and if the resume is immediately paused
// again, that is a real focus holder and we back off.
const FOCUS_GRACE_MS = 1200;        // let a notification tone finish first
const FOCUS_FAIL_WINDOW_MS = 1500;  // re-paused this fast => the resume did not stick
const FOCUS_MAX_STRIKES = 3;        // consecutive failures before we stop trying
const FOCUS_RESET_MS = 10000;       // playing this long => interruption is over
const KEEPALIVE_HZ = 18;            // subsonic: below what a phone speaker can reproduce
const RECENT_MAX = 40;      // how much history we keep in memory
const RECENT_VISIBLE = 6;   // how much of it we render before "Show more"
const SEEN_MAX = 600;

// Baked in so the UI renders instantly and still works offline; refreshed from
// the API on every launch.
const TG_FALLBACK = {
  1: ['CPD Z1', 'Dispatch Zone 1 - Districts 16, 17'],
  2: ['CPD Z2', 'Dispatch Zone 2 - District 19'],
  3: ['CPD Z3', 'Dispatch Zone 3 - Districts 12, 14'],
  4: ['CPD Z4', 'Dispatch Zone 4 - Districts 1, 18'],
  5: ['CPD Z5', 'Dispatch Zone 5 - District 2'],
  6: ['CPD Z6', 'Dispatch Zone 6 - Districts 7, 8'],
  7: ['CPD Z7', 'Dispatch Zone 7 - District 3'],
  8: ['CPD Z8', 'Dispatch Zone 8 - Districts 4, 6'],
  9: ['CPD Z9', 'Dispatch Zone 9 - Districts 5, 22'],
  10: ['CPD Z10', 'Dispatch Zone 10 - Districts 10, 11'],
  11: ['CPD Z11', 'Dispatch Zone 11 - Districts 20, 24'],
  12: ['CPD Z12', 'Dispatch Zone 12 - Districts 15, 25'],
  13: ['CPD Z13', 'Dispatch Zone 13 - District 9'],
  14: ['CPD CW1', 'Citywide 1 - SWAT, K9, traffic/transit, marine'],
  15: ['CPD CW2', 'Citywide 2 - Evidence technicians'],
  16: ['CPD CW3', 'Citywide 3 - Repair service, flash messages'],
  17: ['CPD CW4', 'Citywide 4 - Misc, backup zone'],
  18: ['CPD CW5', 'Citywide 5 - Mass transit, special events'],
  19: ['CPD CW6', 'Citywide 6 - Special events, backup zone'],
  20: ['CPD CW7', 'Citywide 7 - Traffic management'],
};

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Reading localStorage *throws* when a browser is set to block site data, not
// just returns null. An unguarded read in the boot path would take the service
// worker registration and autostart down with it, so funnel every access here.
const store = {
  get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* no storage */ } },
};

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'), statusText: $('statusText'),
  nowLabel: $('nowLabel'), nowTg: $('nowTg'), nowDesc: $('nowDesc'),
  nowTime: $('nowTime'), queueInfo: $('queueInfo'), progressFill: $('progressFill'),
  playBtn: $('playBtn'), skipBtn: $('skipBtn'),
  volume: $('volume'), volLabel: $('volLabel'), volRow: document.querySelector('.vol-row'),
  tgToggle: $('tgToggle'), tgBody: $('tgBody'), tgChips: $('tgChips'), tgSummary: $('tgSummary'),
  optToggle: $('optToggle'), optBody: $('optBody'), optSummary: $('optSummary'),
  liveMode: $('liveMode'), skipShort: $('skipShort'), autoStart: $('autoStart'),
  recentList: $('recentList'), recentToggle: $('recentToggle'), stopBtn: $('stopBtn'),
  installBar: $('installBar'), installBtn: $('installBtn'),
  installClose: $('installClose'), installText: $('installText'),
};

const state = {
  playing: false,
  queue: [],
  current: null,
  recent: [],
  seen: new Set(),
  seenOrder: [],
  cursor: 0,
  talkgroups: {},
  enabled: new Set(),
  liveMode: true,
  skipShort: false,
  autoStart: true,
  volume: 1,
  netFail: 0,
  onSilence: false,
  externalPause: false,
  resumeStrikes: 0,
  recentExpanded: false,
  theme: 'system',
};

// Set immediately before we call audio.pause() ourselves, so the 'pause' handler
// can tell our own pause apart from Android taking audio focus away.
let selfPause = false;

// When we last asked the element to resume, and the pending retry. Used to tell a
// resume that stuck from one that was slapped down by another app.
let lastResumeAt = 0;
let resumeTimer = null;

/* ------------------------------------------------------------------ audio */

let audio = null;
let silenceUrl = null;
let keepAlive = null;               // separate element, plays for the whole session

// A few seconds of 16-bit PCM at +/-1 LSB (about -90 dBFS). Inaudible, but not
// digital silence - some platforms treat an all-zero track as "not playing" and
// tear down the media session, which is exactly what we are trying to avoid.
function makeSilence(seconds) {
  const rate = 8000;
  const frames = rate * seconds;
  const bytes = 44 + frames * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const tag = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  tag(0, 'RIFF'); v.setUint32(4, bytes - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) v.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);

  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// Chrome keeps a backgrounded page alive only while it is producing sound it
// MEASURES as audible (roughly above -60 dBFS). The old keep-alive was +/-1 LSB,
// about -90 dBFS, and the idle loop then ran at volume 0 - both read as silence,
// so the page was frozen seconds after the screen locked and playback stopped
// until the app was reopened.
//
// This tone is ~18 Hz at about -34 dBFS. A phone speaker cannot reproduce 18 Hz
// at any useful level, so it is inaudible in practice, but it is far above the
// silence threshold. It runs on its own element that never stops and never
// changes src, so neither going idle nor swapping clips can interrupt it.
function makeKeepAliveTone(seconds) {
  const rate = 8000;
  const frames = rate * seconds;
  const bytes = 44 + frames * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const tag = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  tag(0, 'RIFF'); v.setUint32(4, bytes - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, frames * 2, true);

  const amp = 0.02;                    // about -34 dBFS
  for (let i = 0; i < frames; i++) {
    const sample = Math.sin(2 * Math.PI * KEEPALIVE_HZ * (i / rate)) * amp;
    v.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function ensureKeepAlive() {
  if (keepAlive) return;
  keepAlive = new Audio();
  keepAlive.src = makeKeepAliveTone(5);
  keepAlive.loop = true;
  keepAlive.preload = 'auto';
  keepAlive.volume = 1;                // the tone itself is what keeps it quiet
}

function ensureAudio() {
  if (audio) return;
  silenceUrl = makeSilence(3);
  audio = new Audio();
  audio.preload = 'auto';
  audio.volume = state.volume;
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('error', onAudioError);
  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('playing', onPlaying);
  audio.addEventListener('pause', onPause);
  audio.addEventListener('waiting', () => setPlayButton('loading'));
}

// Going idle must NOT touch audio.src. Assigning src fires 'emptied', and on
// Android that tears the media session down - which is why the notification
// vanished every time the radio went quiet, while playing fine during a call.
//
// So instead of switching to a silence file, we keep whatever clip is already
// loaded and loop it at zero volume. The element never empties, the session
// never dies, and the lock screen keeps showing "Scanning...".
function playSilence() {
  if (!audio) return Promise.resolve();

  state.onSilence = true;
  state.current = null;

  // Already idling - do not disturb the element at all.
  if (audio.loop && audio.volume === 0 && !audio.paused) {
    setMediaIdle();
    return Promise.resolve();
  }

  // Preferred path: a real clip is loaded, so loop it silently. No src change.
  if (audio.readyState >= 2 && audio.src && audio.src !== silenceUrl) {
    audio.volume = 0;
    audio.loop = true;
    setMediaIdle();
    return audio.paused ? audio.play() : Promise.resolve();
  }

  // Cold start only: nothing has loaded yet, so there is nothing to loop.
  audio.volume = 0;
  audio.loop = true;
  audio.src = silenceUrl;
  setMediaIdle();
  return audio.play();
}

function playCall(call) {
  if (!audio) return;
  state.onSilence = false;
  state.current = call;
  audio.loop = false;
  audio.volume = state.volume;   // undo the zero-volume idle loop
  audio.src = call.url;
  audio.play().catch(() => {});
  addRecent(call);
  updateMediaMetadata(call);
  setPlayButton('loading');
  render();
}

// Advance to the next queued call, or fall back to the silence keep-alive.
function next() {
  if (!state.playing) return;
  trimQueue();
  const call = state.queue.shift();
  if (call) playCall(call);
  else { playSilence().catch(() => {}); render(); }
}

// Android hands audio focus to phone calls, other media apps and navigation
// prompts by pausing our element. Chasing that with play() would yank the
// speaker back and talk over them, so treat an unexpected pause as a stop and
// let the user resume from the lock screen when they are ready.
//
// This is deliberately distinct from the OS *suspending* a backgrounded page,
// which stalls currentTime without firing 'pause' - the watchdog still recovers
// from that, which is what keeps playback alive with the screen off.
function onPause() {
  if (selfPause) { selfPause = false; return; }
  if (!state.playing) return;

  // Getting paused again right after we resumed means something else genuinely
  // holds the speaker. A pause long after a resume is a fresh interruption.
  if (lastResumeAt && Date.now() - lastResumeAt < FOCUS_FAIL_WINDOW_MS) {
    state.resumeStrikes++;
  }

  state.externalPause = true;
  setPlayButton('paused');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';

  if (state.resumeStrikes >= FOCUS_MAX_STRIKES) {
    // Another app owns the speaker. Stop competing; the lock screen and the app
    // can still start us again on purpose.
    setStatus('wait', 'Paused by phone');
    render();
    return;
  }

  setStatus('wait', 'Interrupted');
  render();
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(tryResume, FOCUS_GRACE_MS);
}

// Single place that decides whether resuming is allowed, so the watchdog and the
// post-interruption timer cannot disagree.
function tryResume() {
  if (!state.playing || !audio || !audio.paused) return;
  if (state.externalPause && state.resumeStrikes >= FOCUS_MAX_STRIKES) return;
  lastResumeAt = Date.now();
  audio.play().catch(() => { state.resumeStrikes++; });
}

function onPlaying() {
  state.externalPause = false;
  // Without this the session stays marked 'paused' after any interruption, even
  // though sound is coming out - and Android dismisses a paused media
  // notification, which looks exactly like the app closed itself.
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  setPlayButton('playing');
  setStatus('live', 'Live');
  // The unlock is now confirmed on this element, so it is safe to swap in a real
  // clip if one arrived while we were starting up.
  if (state.onSilence && state.queue.length) next();
}

function onEnded() {
  if (state.onSilence) return;          // looping silence should never end
  state.current = null;
  next();
  requestPoll();   // event-driven refill: keeps working when background timers throttle
}

let errorGuard = 0;
function onAudioError() {
  if (!state.playing || state.onSilence) return;
  const token = ++errorGuard;
  // A dead or 404'd clip should not stall the scanner.
  setTimeout(() => { if (token === errorGuard && state.playing) next(); }, 400);
}

function onTimeUpdate() {
  if (state.onSilence || !audio || !audio.duration || !isFinite(audio.duration)) {
    el.progressFill.style.width = '0%';
    return;
  }
  el.progressFill.style.width = Math.min(100, (audio.currentTime / audio.duration) * 100) + '%';
  updatePositionState();
}

// Gives the Android lock screen a real progress bar for the current call.
function updatePositionState() {
  const ms = navigator.mediaSession;
  if (!ms || typeof ms.setPositionState !== 'function') return;
  if (!audio || state.onSilence || !isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    ms.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(Math.max(audio.currentTime, 0), audio.duration),
    });
  } catch (_) { /* position state is best-effort */ }
}

/* --------------------------------------------------------------- transport */

function start(opts) {
  const auto = !!(opts && opts.auto);
  ensureAudio();
  ensureKeepAlive();
  // Started inside the same gesture as the main element so it is unlocked too.
  keepAlive.play().catch(() => {});
  state.playing = true;
  state.externalPause = false;   // an explicit start overrides a focus-loss pause
  state.resumeStrikes = 0;
  // Pressing play after a long pause should rejoin live traffic. Without this
  // the cursor is still minutes old, so the next poll returns a huge backlog and
  // you hear stale calls before catching up.
  if (!state.cursor || (state.liveMode && Date.now() - state.cursor > STALE_RESUME_MS)) {
    state.cursor = Date.now() - START_LOOKBACK_MS;
    state.queue.length = 0;
  }

  // play() must be called synchronously inside the tap for iOS to unlock the
  // element. Everything else can happen afterwards.
  playSilence().catch(() => {
    // Autoplay on launch is best-effort: browsers block it until the user has
    // interacted with the app at least once. Fall back to the play button
    // rather than sitting there looking broken.
    if (!auto) return;
    state.playing = false;
    stopTimers();
    setPlayButton('paused');
    setStatus('idle', 'Tap to start');
    render();
  });

  setupMediaSession();
  setPlayButton('loading');
  setStatus('wait', 'Connecting');
  requestPoll();
  startTimers();
  render();
}

function stop() {
  state.playing = false;
  if (audio) { selfPause = true; audio.pause(); }
  if (keepAlive) keepAlive.pause();
  state.onSilence = false;
  state.externalPause = false;
  state.resumeStrikes = 0;
  clearTimeout(resumeTimer); resumeTimer = null;
  stopTimers();
  setPlayButton('paused');
  setStatus('idle', 'Paused');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  render();
}

function toggle() { state.playing ? stop() : start(); }

// Emergency stop. A page can only close a window it opened itself, so closing is
// best-effort - but silencing is not. Everything below runs first and
// unconditionally: the element is torn down and the media session dropped, so
// nothing can keep playing or be restarted from the lock screen, whether or not
// the window actually closes.
function emergencyStop() {
  state.playing = false;
  state.queue.length = 0;
  state.current = null;
  state.onSilence = false;
  state.externalPause = false;
  state.resumeStrikes = 0;
  clearTimeout(resumeTimer); resumeTimer = null;
  stopTimers();

  if (audio) {
    selfPause = true;
    audio.pause();
    audio.loop = false;
    // Detach the source so no timer, event or handler can resume it.
    audio.removeAttribute('src');
    try { audio.load(); } catch (_) { /* already empty */ }
  }

  // The keep-alive is what holds the page awake, so an emergency stop has to
  // take it down too - otherwise the tone keeps the app running in the
  // background, which is the exact opposite of what this button is for.
  if (keepAlive) {
    keepAlive.pause();
    keepAlive.loop = false;
    // ensureKeepAlive generates a fresh blob each time, so without revoking this
    // one every stop/start cycle would strand another copy of the tone in memory.
    const toneUrl = keepAlive.getAttribute('src');
    keepAlive.removeAttribute('src');
    try { keepAlive.load(); } catch (_) {}
    if (toneUrl && toneUrl.indexOf('blob:') === 0) URL.revokeObjectURL(toneUrl);
    keepAlive = null;
  }

  // Dropping metadata and the action handlers is what removes the Android
  // notification; leaving them would keep a dead card with live controls.
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
      for (const action of ['play', 'pause', 'stop', 'nexttrack', 'seekforward']) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch (_) {}
      }
    } catch (_) { /* not supported */ }
  }

  setPlayButton('paused');
  setStatus('idle', 'Stopped');
  render();

  // Only now, once it is provably silent, try to close.
  setTimeout(() => { try { window.close(); } catch (_) {} }, 150);
}

function trimQueue() {
  if (state.liveMode) {
    // Several zones talk at once, so the backlog can outrun real time. Stay near live.
    if (state.queue.length > 6) state.queue.splice(0, state.queue.length - 3);
  } else if (state.queue.length > 250) {
    state.queue.splice(0, state.queue.length - 250);
  }
}

/* ---------------------------------------------------------------- polling */

let pollTimer = null, watchTimer = null;
let polling = false;
let lastPos = -1, stallTicks = 0;

let lastPollAt = 0, pendingPoll = null;

// Every refill goes through here. If a poll happened too recently the request is
// coalesced into a single deferred one rather than dropped, so an 'ended' event
// during a throttled window still refills the queue - just a moment later.
// Repeated failures usually mean Cloudflare is challenging us, and polling at the
// normal rate through a challenge just prolongs it. Back off exponentially and
// let it clear; a single success resets netFail and restores the normal cadence.
function pollBackoffMs() {
  if (state.netFail < 2) return 0;
  return Math.min(60000, POLL_MIN_GAP_MS * Math.pow(2, Math.min(state.netFail - 1, 6)));
}

function requestPoll() {
  const gap = Math.max(POLL_MIN_GAP_MS, pollBackoffMs());
  const wait = gap - (Date.now() - lastPollAt);
  if (wait <= 0) { poll(); return; }
  if (pendingPoll) return;
  pendingPoll = setTimeout(() => { pendingPoll = null; poll(); }, wait);
}

function startTimers() {
  stopTimers();
  pollTimer = setInterval(requestPoll, POLL_MS);
  watchTimer = setInterval(watchdog, 4000);
}

function stopTimers() {
  clearInterval(pollTimer); pollTimer = null;
  clearInterval(watchTimer); watchTimer = null;
  clearTimeout(pendingPoll); pendingPoll = null;
}

// Recovers from the two ways background playback dies: the OS pausing us, and a
// clip that loads but never advances.
function watchdog() {
  if (!state.playing || !audio) return;

  // If the OS paused the keep-alive, the page loses its protection entirely, so
  // this matters more than the main element.
  if (keepAlive && keepAlive.paused) keepAlive.play().catch(() => {});

  // Backstop for the resume timer, which a frozen background page can lose.
  if (audio.paused) { tryResume(); return; }

  // Playing steadily for a while means the interruption is genuinely over.
  if (lastResumeAt && Date.now() - lastResumeAt > FOCUS_RESET_MS) state.resumeStrikes = 0;

  if (state.onSilence) { stallTicks = 0; return; }
  if (audio.currentTime === lastPos) {
    if (++stallTicks >= 3) { stallTicks = 0; next(); }
  } else {
    stallTicks = 0;
  }
  lastPos = audio.currentTime;
}

// fetch() has no default timeout. A connection that hangs instead of failing -
// routine on mobile when you drift out of coverage - would leave the in-flight
// guard stuck and silently stop the scanner refilling for good.
async function fetchJson(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function markSeen(id) {
  state.seen.add(id);
  state.seenOrder.push(id);
  if (state.seenOrder.length > SEEN_MAX) state.seen.delete(state.seenOrder.shift());
}

async function poll() {
  if (polling) return;
  polling = true;
  lastPollAt = Date.now();
  try {
    const since = state.cursor || (Date.now() - START_LOOKBACK_MS);
    const data = await fetchJson(`${API}/${SYSTEM}/calls/newer?time=${since}`);

    const calls = (data.calls || []).slice()
      .sort((a, b) => new Date(a.time) - new Date(b.time));

    let added = 0;
    for (const c of calls) {
      const ms = new Date(c.time).getTime();
      if (ms > state.cursor) state.cursor = ms;
      if (!c._id || state.seen.has(c._id)) continue;
      markSeen(c._id);
      if (!c.url) continue;   // nothing playable; don't queue a guaranteed 404
      // The enabled set is built from the talkgroups we know about, so a newly
      // added one would be filtered out forever. Let unknown talkgroups through.
      const known = Object.prototype.hasOwnProperty.call(state.talkgroups, c.talkgroupNum);
      if (known && !state.enabled.has(c.talkgroupNum)) continue;
      if (state.skipShort && (c.len || 0) < 2) continue;
      state.queue.push(c);
      added++;
    }

    state.netFail = 0;
    if (added) {
      trimQueue();
      if (state.playing && state.onSilence) next();
    }
    if (state.playing && !state.externalPause && state.netFail === 0 &&
        !(el.status.dataset.state || '').startsWith('live')) {
      setStatus('live', 'Live');
    }
  } catch (err) {
    state.netFail++;
    if (state.netFail >= 2) setStatus('error', 'Reconnecting');
  } finally {
    polling = false;
    renderMeta();
  }
}

async function loadTalkgroups() {
  applyTalkgroups(TG_FALLBACK);
  try {
    const cached = JSON.parse(store.get('cpd.tg') || 'null');
    if (cached && Object.keys(cached).length) applyTalkgroups(cached);
  } catch (_) { /* ignore bad cache */ }

  try {
    const data = await fetchJson(`${API}/${SYSTEM}/talkgroups`);
    const slim = {};
    for (const key of Object.keys(data.talkgroups || {})) {
      const t = data.talkgroups[key];
      slim[t.num] = [t.alpha || ('TG ' + t.num), (t.description || '').trim()];
    }
    if (Object.keys(slim).length) {
      applyTalkgroups(slim);
      store.set('cpd.tg', JSON.stringify(slim));
    }
  } catch (_) { /* keep whatever we already have */ }
  renderChips();
}

function applyTalkgroups(map) {
  state.talkgroups = map;
  if (!state.enabled.size) state.enabled = new Set(Object.keys(map).map(Number));
}

function tgInfo(num) {
  const t = state.talkgroups[num];
  return { alpha: (t && t[0]) || ('Talkgroup ' + num), desc: (t && t[1]) || '' };
}

/* ---------------------------------------------------------- media session */

function iconSet() {
  const abs = (p) => new URL(p, location.href).href;
  return [
    { src: abs('icons/icon-192.png'), sizes: '192x192', type: 'image/png' },
    { src: abs('icons/icon-512.png'), sizes: '512x512', type: 'image/png' },
  ];
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch (_) {} };
  // Pressing play on the lock screen is an explicit request, so it clears a
  // focus-loss pause and takes the speaker back.
  set('play', () => {
    state.externalPause = false;
    if (!state.playing) start();
    else if (audio) audio.play().catch(() => {});
  });
  set('pause', stop);
  set('stop', stop);
  set('nexttrack', () => { if (state.playing) next(); });
  set('seekforward', () => { if (state.playing) next(); });
  setMediaIdle();
}

function updateMediaMetadata(call) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  const tg = tgInfo(call.talkgroupNum);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: tg.alpha,
    artist: tg.desc || 'Chicago Police',
    album: 'Chicago Scanner',
    artwork: iconSet(),
  });
  navigator.mediaSession.playbackState = 'playing';
}

function setMediaIdle() {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: 'Scanning…',
    artist: 'Waiting for the next call',
    album: 'Chicago Scanner',
    artwork: iconSet(),
  });
  navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
}

/* -------------------------------------------------------------------- ui */

const clock = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

// Intl throws RangeError on an invalid date, which would take the whole render
// down. One malformed call from the API shouldn't blank the UI.
function timeLabel(value) {
  // new Date(null) is epoch 0, a *valid* date - so a null time would render as
  // 1970 rather than being rejected. Screen those out before parsing.
  if (value === null || value === undefined || value === '') return '--:--:--';
  const d = new Date(value);
  return isNaN(d.getTime()) ? '--:--:--' : clock.format(d);
}

/* ----------------------------------------------------------------- theme */

// Theme lives under its own key because the inline script in index.html reads it
// before first paint to avoid flashing the wrong palette.
const THEME_KEY = 'cpd.theme';
// The Day value is a shade darker than the page background on purpose: matching
// it exactly merged the status bar into the app, so the notification icons had
// no defined band to sit on and read as missing.
const THEME_BG = { dark: '#0a0f1e', light: '#dbe4f2' };
const themeMetas = document.querySelectorAll('meta[name="theme-color"]');
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// System leaves the media-scoped pair intact so the browser tracks the OS on its
// own; an explicit choice pins both entries to the same colour, which works
// regardless of which media query happens to match.
function setThemeColor(choice) {
  for (const m of themeMetas) {
    const isDarkSlot = (m.getAttribute('media') || '').includes('dark');
    const value = choice === 'system'
      ? (isDarkSlot ? THEME_BG.dark : THEME_BG.light)
      : (choice === 'dark' ? THEME_BG.dark : THEME_BG.light);
    m.setAttribute('content', value);
  }
}

function applyTheme(choice) {
  state.theme = (choice === 'light' || choice === 'dark') ? choice : 'system';
  const root = document.documentElement;

  // System mode means "no opinion" - drop the attribute and let the stylesheet's
  // prefers-color-scheme query decide.
  if (state.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', state.theme);

  setThemeColor(state.theme);

  for (const btn of document.querySelectorAll('[data-theme-choice]')) {
    btn.setAttribute('aria-checked', String(btn.dataset.themeChoice === state.theme));
  }
  renderMeta();
}

// Prints the build this page is running, and flags the case that used to be
// invisible: the worker has a newer build cached than the JS currently executing,
// which means the code on screen is stale.
async function renderBuildTag() {
  const tag = $('buildTag');
  if (!tag) return;
  tag.textContent = 'Build ' + APP_VERSION;
  try {
    const keys = await caches.keys();
    const active = keys.find((k) => k.indexOf('cpd-scanner-') === 0);
    if (!active) return;
    const swVersion = active.slice('cpd-scanner-'.length);
    if (swVersion === APP_VERSION) return;
    // Make the fix one tap away instead of a settings expedition.
    const note = document.createElement('a');
    note.className = 'stale';
    note.href = 'reset.html';
    note.textContent = '  ·  ' + swVersion + ' ready — tap to update';
    tag.appendChild(note);
  } catch (_) { /* no cache access; the plain build number is still useful */ }
}

function setStatus(kind, text) {
  el.status.dataset.state = kind;
  el.statusText.textContent = text || kind;
}

function setPlayButton(mode) {
  el.playBtn.dataset.state = mode;
  const playing = mode === 'playing' || mode === 'loading';
  el.playBtn.setAttribute('aria-label', playing ? 'Pause scanner' : 'Play scanner');
}

function addRecent(call) {
  state.recent = state.recent.filter((c) => c._id !== call._id);
  state.recent.unshift(call);
  if (state.recent.length > RECENT_MAX) state.recent.length = RECENT_MAX;
  // No render here: the only caller is playCall(), which renders straight after.
}

function render() { renderNow(); renderMeta(); renderRecent(); }

function renderNow() {
  const c = state.current;
  if (c) {
    const tg = tgInfo(c.talkgroupNum);
    el.nowLabel.textContent = 'On air';
    el.nowTg.textContent = tg.alpha;
    el.nowDesc.textContent = tg.desc;
  } else if (state.playing) {
    el.nowLabel.textContent = 'Scanning';
    el.nowTg.textContent = 'Waiting for a call';
    el.nowDesc.textContent = state.enabled.size
      ? 'The radio is quiet on your selected channels.'
      : 'No channels selected — pick at least one under Channels.';
    el.progressFill.style.width = '0%';
  } else {
    el.nowLabel.textContent = 'Ready';
    el.nowTg.textContent = 'Chicago Police Scanner';
    el.nowDesc.textContent = 'Tap play to start listening. Audio keeps going with your screen off.';
    el.progressFill.style.width = '0%';
  }
}

function renderMeta() {
  const c = state.current;
  el.nowTime.textContent = c ? timeLabel(c.time) : ' ';
  if (!state.playing) el.queueInfo.textContent = ' ';
  else if (state.queue.length) el.queueInfo.textContent = state.queue.length + ' queued';
  else el.queueInfo.textContent = 'Up to date';

  const total = Object.keys(state.talkgroups).length;
  const on = state.enabled.size;
  el.tgSummary.textContent = on === total ? `All ${total}` : `${on} of ${total}`;
  const themeName = { light: 'Day', dark: 'Night', system: 'Auto' }[state.theme] || 'Auto';
  el.optSummary.textContent = (state.liveMode ? 'Live' : 'Everything') + ' · ' + themeName;
  el.skipBtn.disabled = !state.playing;
}

function renderChips() {
  const nums = Object.keys(state.talkgroups).map(Number).sort((a, b) => a - b);
  el.tgChips.textContent = '';
  for (const num of nums) {
    const tg = tgInfo(num);
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = tg.alpha;
    b.title = tg.desc;
    b.dataset.num = String(num);
    b.setAttribute('aria-pressed', state.enabled.has(num) ? 'true' : 'false');
    b.addEventListener('click', () => {
      if (state.enabled.has(num)) state.enabled.delete(num); else state.enabled.add(num);
      b.setAttribute('aria-pressed', state.enabled.has(num) ? 'true' : 'false');
      state.queue = state.queue.filter((c) => state.enabled.has(c.talkgroupNum));
      saveSettings(); renderMeta();
    });
    el.tgChips.appendChild(b);
  }
  renderMeta();
}

function renderRecent() {
  const keepScroll = el.recentList.scrollTop;
  el.recentList.textContent = '';

  if (!state.recent.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing yet — press play.';
    el.recentList.appendChild(li);
    el.recentToggle.hidden = true;
    el.recentList.classList.remove('is-expanded');
    return;
  }

  // Render only a handful by default. A scanner running for an hour would
  // otherwise turn this into thousands of pixels of scroll.
  const items = state.recentExpanded ? state.recent : state.recent.slice(0, RECENT_VISIBLE);

  for (const c of items) {
    const tg = tgInfo(c.talkgroupNum);
    const isCurrent = !!(state.current && state.current._id === c._id);
    const li = document.createElement('li');
    if (isCurrent) li.className = 'is-current';

    if (isCurrent) {
      const live = document.createElement('span');
      live.className = 'rc-live';
      live.setAttribute('aria-label', 'Now playing');
      li.appendChild(live);
    }

    const main = document.createElement('div');
    main.className = 'rc-main';
    const t = document.createElement('div');
    t.className = 'rc-tg';
    t.textContent = tg.alpha + (c.emergency ? '  ⚠ emergency' : '');
    const s = document.createElement('div');
    s.className = 'rc-sub';
    s.textContent = tg.desc;
    main.append(t, s);

    const time = document.createElement('span');
    time.className = 'rc-time';
    time.textContent = timeLabel(c.time);

    const replay = document.createElement('button');
    replay.className = 'rc-replay';
    replay.type = 'button';
    replay.setAttribute('aria-label', 'Replay this call');
    replay.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
    replay.addEventListener('click', () => {
      if (!state.playing) start();
      ensureAudio();
      playCall(c);
    });

    li.append(main, time, replay);
    el.recentList.appendChild(li);
  }

  // A live count here climbed with every call, so the button's text and width
  // kept shifting under the user. Static label instead.
  el.recentToggle.hidden = state.recent.length <= RECENT_VISIBLE;
  el.recentToggle.textContent = state.recentExpanded ? 'Show less' : 'Show more';
  el.recentToggle.setAttribute('aria-expanded', String(state.recentExpanded));
  el.recentList.classList.toggle('is-expanded', state.recentExpanded);

  // Calls land every few seconds and rebuild this list, so hold the user's
  // place instead of snapping them back to the top while they read.
  if (state.recentExpanded) el.recentList.scrollTop = keepScroll;
}

/* -------------------------------------------------------------- settings */

function saveSettings() {
  store.set('cpd.settings', JSON.stringify({
    enabled: [...state.enabled],
    liveMode: state.liveMode,
    skipShort: state.skipShort,
    autoStart: state.autoStart,
    volume: state.volume,
  }));
}

function loadSettings() {
  let s = null;
  try { s = JSON.parse(store.get('cpd.settings') || 'null'); } catch (_) {}
  if (!s) return;
  if (Array.isArray(s.enabled) && s.enabled.length) state.enabled = new Set(s.enabled.map(Number));
  if (typeof s.liveMode === 'boolean') state.liveMode = s.liveMode;
  if (typeof s.skipShort === 'boolean') state.skipShort = s.skipShort;
  if (typeof s.autoStart === 'boolean') state.autoStart = s.autoStart;
  if (typeof s.volume === 'number') state.volume = s.volume;
}

/* ----------------------------------------------------------------- wiring */

el.playBtn.addEventListener('click', toggle);
el.skipBtn.addEventListener('click', () => { if (state.playing) next(); });
el.stopBtn.addEventListener('click', emergencyStop);

el.recentToggle.addEventListener('click', () => {
  state.recentExpanded = !state.recentExpanded;
  renderRecent();
});

el.volume.addEventListener('input', () => {
  state.volume = Number(el.volume.value) / 100;
  // Never raise the element's volume while it is idling. Idle loops the LAST
  // CLIP at volume 0, so unmuting it replays that transmission out loud, on
  // repeat. playCall applies state.volume when the next call starts.
  if (audio && !state.onSilence) audio.volume = state.volume;
  el.volLabel.textContent = el.volume.value;
  saveSettings();
});

function wirePanel(btn, body) {
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    body.hidden = open;
  });
}
wirePanel(el.tgToggle, el.tgBody);
wirePanel(el.optToggle, el.optBody);

document.querySelectorAll('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const all = Object.keys(state.talkgroups).map(Number);
    const p = btn.dataset.preset;
    if (p === 'all') state.enabled = new Set(all);
    else if (p === 'none') state.enabled = new Set();
    else if (p === 'zones') state.enabled = new Set(all.filter((n) => tgInfo(n).alpha.includes(' Z')));
    else if (p === 'citywide') state.enabled = new Set(all.filter((n) => tgInfo(n).alpha.includes('CW')));
    state.queue = state.queue.filter((c) => state.enabled.has(c.talkgroupNum));
    saveSettings();
    renderChips();
  });
});

for (const btn of document.querySelectorAll('[data-theme-choice]')) {
  btn.addEventListener('click', () => {
    applyTheme(btn.dataset.themeChoice);
    store.set(THEME_KEY, state.theme);
  });
}

// In System mode, follow the OS if it flips (Samsung's scheduled night mode does
// this at sunset) so the address-bar colour and palette stay in step.
if (typeof darkQuery.addEventListener === 'function') {
  darkQuery.addEventListener('change', () => {
    if (state.theme === 'system') applyTheme('system');
  });
}

el.liveMode.addEventListener('change', () => {
  state.liveMode = el.liveMode.checked; saveSettings(); renderMeta();
});
el.skipShort.addEventListener('change', () => {
  state.skipShort = el.skipShort.checked; saveSettings();
});
el.autoStart.addEventListener('change', () => {
  state.autoStart = el.autoStart.checked; saveSettings(); renderMeta();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.playing) return;
  requestPoll();
  // Bringing the app to the front is an explicit signal you want it playing, so
  // give it a clean slate even if we had backed off.
  state.resumeStrikes = 0;
  tryResume();
});
window.addEventListener('online', () => { if (state.playing) requestPoll(); });

/* ------------------------------------------------------------- install ui */

let deferredPrompt = null;

function setInstallBar(show) {
  el.installBar.hidden = !show;
  document.body.classList.toggle('has-install', show);
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (store.get('cpd.installDismissed')) return;
  setInstallBar(true);
});

el.installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  setInstallBar(false);
});

el.installClose.addEventListener('click', () => {
  setInstallBar(false);
  store.set('cpd.installDismissed', '1');
});

// Once it is running as an installed app the banner is meaningless.
window.addEventListener('appinstalled', () => setInstallBar(false));

function maybeShowIosInstallHint() {
  const standalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  if (!IS_IOS || standalone || store.get('cpd.installDismissed')) return;
  el.installText.textContent = 'For background audio: tap Share, then Add to Home Screen.';
  el.installBtn.hidden = true;
  setInstallBar(true);
}

/* ------------------------------------------------------------------ boot */

function boot() {
  applyTheme(store.get(THEME_KEY) || 'system');
  loadSettings();
  el.liveMode.checked = state.liveMode;
  el.skipShort.checked = state.skipShort;
  el.autoStart.checked = state.autoStart;
  el.volume.value = String(Math.round(state.volume * 100));
  el.volLabel.textContent = el.volume.value;

  // iOS ignores HTMLMediaElement.volume; the hardware buttons are the only control.
  if (IS_IOS) el.volRow.hidden = true;

  setStatus('idle', 'Idle');
  setPlayButton('paused');
  render();
  renderBuildTag();
  loadTalkgroups();
  maybeShowIosInstallHint();

  if ('serviceWorker' in navigator) {
    // The shell is served cache-first, so without this a fix only reaches the
    // user on some *later* launch - they sit on stale code with no way to know.
    // The worker calls skipWaiting/claim, so take control as a cue to reload.
    const hadController = !!navigator.serviceWorker.controller;
    const bootAt = Date.now();
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;          // first install: nothing to replace
      // Never cut off a session already in progress; at launch it's free.
      if (Date.now() - bootAt > 10000 && audio && !audio.paused) return;
      reloading = true;
      location.reload();
    });
    window.addEventListener('load', () => {
      // updateViaCache:'none' stops the browser serving sw.js itself from the
      // HTTP cache, which can otherwise pin a user to an old worker for hours.
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
        .then((reg) => {
          reg.update();
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') reg.update();
          });
        })
        .catch(() => {});
    });
  }

  // Open the app and it is already scanning - no dialog, no setup.
  if (state.autoStart) start({ auto: true });
}

boot();
