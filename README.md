# Chicago Police Scanner

A small, installable web app that plays live Chicago Police radio traffic from
[OpenMHz](https://openmhz.com/system/chi_cpd) — and **keeps playing while your phone is
locked and you're in other apps**.

No build step, no dependencies, no server of your own. It's four static files plus icons,
so GitHub Pages can host it for free.

![Chicago Police Scanner](icons/icon-192.png)

## What it does

- Streams every call from the `chi_cpd` system, newest first, back to back
- **Starts playing the moment you open it** — no dialog, no setup
- Keeps going with the screen off, with lock-screen play/pause/skip controls
- Filter by channel: 13 dispatch zones (by district) and 7 citywide channels
- **Live mode** skips the backlog so you stay close to real time
- Recent-call list with one-tap replay, capped so the page never grows unbounded
- **Day / Night / Auto** appearance, Auto following your phone
- Remembers your channels and settings

## Install it on your phone

Background audio is much more reliable once the app is installed to your home screen,
because it runs as its own app instead of a browser tab.

**iPhone / iPad (Safari)**
1. Open the site in **Safari** (this doesn't work from Chrome on iOS)
2. Tap the **Share** button, then **Add to Home Screen**
3. Open it from the home-screen icon
4. Tap play once — iOS requires one tap before any audio can start

**Android (Chrome)**
1. Open the site in Chrome
2. Tap **Install** on the banner, or menu → **Install app**
3. Open it from the app icon

## Playing with the screen off

Once it's playing, lock your phone or switch apps and audio continues. Your lock screen
gets standard media controls (play, pause, skip to next call).

**It yields the speaker.** When a phone call, another media app, or a navigation prompt
takes audio focus, Android pauses the scanner and it *stays* paused — it won't fight you
for the speaker. The status reads "Paused by phone"; press play on the lock screen to take
it back. This is deliberately different from the OS *suspending* a backgrounded page,
which stalls playback without a `pause` event — the watchdog does recover from that, and
that's what keeps audio alive with the screen off.

Two honest caveats:

- **iOS needs one tap to start.** Safari blocks audio until you interact with the page, so
  "start playing when I open the app" can't fire on a cold launch on iPhone. You tap play
  once, and from then on it runs unattended. On Android it usually autostarts outright.
- **Don't force-quit the app.** Swiping it away from the app switcher stops the audio, the
  same as it would for a podcast player.

If audio ever stops, opening the app resumes it — there's a watchdog that restarts
playback and re-syncs whenever the app becomes visible again.

### Samsung / One UI

Samsung's battery management is the most common reason background audio dies overnight on
a Galaxy, and it will happily sleep an installed PWA. After installing, set:

- **Settings → Apps → Chicago Scanner → Battery → Unrestricted**
- **Settings → Battery → Background usage limits** — make sure the app is *not* listed
  under "Sleeping apps" or "Deep sleeping apps"
- Turn off **Put unused apps to sleep** in that same screen, or the app gets slept after a
  few days of not opening it

Both Chrome and Samsung Internet support install and lock-screen controls.

## How it works

Two constraints shaped the whole design, and both are worth knowing before changing
anything:

**1. The audio files have no CORS headers.** Clips are served from `media2.openmhz.com` as
`application/octet-stream` with no `Access-Control-Allow-Origin`. That makes `fetch()` +
Web Audio decoding impossible from another origin. Everything has to go through a plain
`<audio>` element, which isn't subject to CORS. (The JSON API *is* wide open —
`Access-Control-Allow-Origin: *` — so no proxy is needed for call metadata.)

**2. Background audio only survives while sound is actually playing.** Mobile browsers
keep a backgrounded page alive — timers and all — only while a media element is producing
audio. And iOS only lets you call `play()` programmatically on an element a user gesture
already unlocked.

So the app uses **one `<audio>` element for the entire session**, unlocked by the first
tap and never replaced. When the queue runs dry it loops a few seconds of near-silent
audio (16-bit PCM at ±1 LSB, about −90 dBFS) rather than stopping. That keeps the media
session — and therefore the page, its timers, and your lock-screen controls — alive
through radio silence. Digital-zero silence is deliberately avoided; some platforms treat
an all-zero track as "not playing" and tear the session down.

New calls are pulled from `GET /chi_cpd/calls/newer?time=<epoch_ms>` every 5 seconds,
**and** on every `ended` event. That second trigger is the important one: background
timers get throttled, but media events keep firing, so playback itself drives the refill.

Both triggers go through a single throttle with a 3-second floor. Without it, busy
traffic fired the `ended` refill roughly once a second — measured at 28 requests/minute
against an intended 12 — which is what starts Cloudflare challenging the client. Requests
inside the floor are coalesced into one deferred poll rather than dropped, so a call
ending during a throttled window still refills the queue, just a moment later.

### Why not the websocket?

OpenMHz's backend ([openmhz/trunk-server](https://github.com/openmhz/trunk-server))
does expose a socket.io feed that emits a `new message` event per call. This app polls
instead, on purpose:

- Polling needs no client library; socket.io would be the app's only dependency
- A websocket gets suspended in the background just like a timer, whereas the
  `ended`-driven refill is tied to playback — which is precisely what keeps the page alive
- Scanner audio is already delayed by seconds; sub-second push latency buys nothing

If you want push updates, that's the hook to use.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Markup and PWA meta tags |
| `app.js` | Playback engine, polling, media session, UI |
| `styles.css` | Dark, mobile-first styling |
| `sw.js` | Service worker — caches the shell so it installs and launches offline |
| `manifest.webmanifest` | PWA manifest |
| `tools/make-icons.js` | Regenerates the PNG icons (`node tools/make-icons.js`) |

The service worker is **network-first** for the app shell only — it never touches the API
or the audio. The network is raced against a 3s timeout, so a hung mobile connection
falls back to cache rather than stalling the launch, and the app still opens offline.

This started out stale-while-revalidate for a faster launch. That was the wrong trade:
the shell is a few KB, but cache-first left the app running old code with no way to know
or escape it, so shipped fixes looked like they had never landed. A ~100ms wait is
cheaper than being a version behind.

### Bump the version on every change

`APP_VERSION` in `app.js` and `CACHE` in `sw.js` must always move together, and both get
bumped on *any* app edit — even one that wouldn't strictly need it. The version is
printed at the bottom of the app, so what's running on the phone can be checked by eye
instead of assumed. If the worker has a newer build cached than the running JS, the tag
says so.

```bash
node tools/check-version.js
```

Run that before committing; it fails if the two drift apart.

### The status bar on an installed app

Once installed, Android takes the status bar colour from `theme_color` in
`manifest.webmanifest`, captured at install time — the runtime
`<meta name="theme-color">` that Day/Night switching updates does **not** reliably
override it in standalone mode. That's why an installed app showed a black status bar
above the light Day theme.

`theme_color` is a single static value with no media-query equivalent, so it cannot
follow the in-app theme. It is set to the Day colour (`#dbe4f2`), which means Night mode
may show a light status bar on an installed app where the meta override is ignored. That
is a deliberate trade, not an oversight.

Changing it requires **uninstalling and reinstalling** the app — Chrome re-reads the
manifest on its own schedule, so a plain reload will not pick it up.

### If the app gets stuck on an old build

Open **`/reset.html`**. It unregisters every service worker, deletes every cache, and
reloads the current build.

This exists because "just reopen the app" does not work when the worker itself is the
problem — a cache-first worker serves its own copy of every cached path, so every route
into the app is already poisoned, including whatever code was meant to fix it.
`reset.html` escapes that because an old worker has never cached *that* path: the lookup
misses and the request falls through to the network.

Two rules keep it working, and both matter:

- It is entirely self-contained — no `styles.css`, no `app.js`, no icons. Any external
  file would be served by the very worker it exists to remove.
- The service worker skips it explicitly, so the repair tool can never itself go stale.

The build tag links here automatically when the worker holds a newer build than the
running JavaScript.

## Running it locally

```bash
python -m http.server 5173
```

Then open `http://localhost:5173`. Any static server works; it's plain files.

## Deploying to GitHub Pages

Push to a repo, then **Settings → Pages → Source: Deploy from a branch**, branch
`main`, folder `/ (root)`. The site appears at `https://<user>.github.io/<repo>/`.

Every path in the app is relative, so it works from a subpath without changes.
`.nojekyll` is included so GitHub serves the files as-is.

HTTPS is required for the service worker and for install — GitHub Pages provides it.

## Notes

Audio comes from OpenMHz, which is community-run and free. Be a good citizen: the polling
interval is deliberately modest, so please don't crank it down.

Radio traffic is delayed and may be incomplete or unavailable if the feed goes down or
channels are encrypted. This is for listening only — never use it to interfere with an
emergency response.
