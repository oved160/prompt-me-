# Prompt Me — a voice-controlled teleprompter

A teleprompter that lives in your browser. It puts your script on top of your live camera
feed and scrolls it **as you speak**, so you can read a script while looking straight down
the lens instead of off to the side.

No account, no server, no install. Your video never leaves your device. Your **voice** does:
Chrome transcribes speech on Google's servers, so voice pacing needs a connection. Turn it
off and everything stays local. Nothing else in the app makes a network request at all.

**Live demo:** _(deploy link goes here)_

> **The interesting part:** matching messy live speech against a written script, in
> [`js/matcher.js`](js/matcher.js) and [`js/transcript.js`](js/transcript.js). Skip to
> [how the voice matching works](#how-the-voice-matching-works) if that's why you're here.

## What it does

- **Live camera background** — your front camera sits behind your script, framed to exactly
  what will be recorded.
- **Voice-paced scrolling** — the browser's built-in speech recognition listens to you read
  and moves the script to keep up. It matches loosely, so a fluffed word or an ad-lib
  won't throw it off.
- **Constant-speed fallback** — a classic teleprompter with a speed slider, for when voice
  isn't working for you (noisy room, unsupported browser, or you just prefer it).
- **Word tracking during a take, where the phone allows it** — recognition keeps running
  when recording starts, because plenty of hardware runs both at once. Only if no word
  arrives in the first few seconds does the app conclude this device cannot share the
  microphone and drop to pacing by sound: the script then advances while you speak and
  holds in the gaps, which knows *that* you are talking but not *where* you are. It says
  which of the two it is using. A side effect worth knowing: the microphone is only ever
  open while actually recording, not for the whole session.
- **The next word is marked** — the word you are about to say is highlighted like a
  highlighter pen. When the script is pacing by sound rather than recognition the highlight
  follows the prompter's own position, so it still shows where you are rather than
  inventing a word it never heard.
- **Watch it back before you keep it** — stopping a take opens a review screen with a real
  player: scrub, skip back five seconds, jump to the start, and an elapsed-of-total readout.
  Save it, shoot it again, or discard it. Nothing is written to your device until you choose
  to save, and the file is named by take number.
- **The camera switches off the moment you stop shooting** — the indicator light goes out
  before the review screen appears, not when you eventually leave the page.
- **Takes are numbered** — the slate counts attempts the way a real one does. Every time you
  roll, the number goes up, whether or not that take survives, and the saved file carries it.
- **Record and save** — record yourself straight from the app at 1080p. On a phone this opens
  the native share sheet, so the video goes into your gallery.
- **Pause the take** — tap the recording badge to hold mid-sentence and pick up again, and
  it all lands in one continuous file. The script pauses with it, and the clock only counts
  time that actually made it into the video.
- **Mirrored by default** — a phone propped beside the lens is being used as a mirror, and an
  unmirrored preview makes people correct the wrong way. The recording itself is never
  mirrored.
- **Tap anywhere to pause** — the whole script area is the pause target. Hunting for a small
  button mid-sentence is the thing that actually fails on a phone.
- **Waits for you** — it holds at the top until you tap, then counts down 3-2-1. Hitting
  record before you've started counts down once and begins both together.
- **Tells you when it's lost** — if voice pacing stops following you, it says so instead of
  leaving you staring at a script that won't move, and widens its search to find you again.
- **Keeps the screen awake** — the phone won't dim or lock partway through a take.
- **Keeps your layout** — line breaks and blank lines are preserved exactly as you typed
  them, so your phrasing survives instead of becoming one continuous river of text.
- **Remembers** — your script, language, and slider settings survive a refresh.

## Run it locally

Any static file server works. It cannot be opened as a `file://` path, because the camera
and microphone APIs require a secure context (`https://` or `localhost`).

```bash
npx serve .
```

Then open the printed `http://localhost:...` URL in Chrome.

Run the matcher's test suite with:

```bash
npm test
```

## Known limitations

- **Chrome (or Edge) only, for the voice part.** Voice pacing uses the Web Speech API, which
  Chrome and Edge implement and Firefox and iOS Safari effectively do not. In an unsupported
  browser the app still works — it just falls back to constant-speed scrolling.
- **Speech recognition is not offline.** Chrome streams your microphone audio to Google's
  servers for transcription. It's free, but it isn't private and it needs an internet
  connection. Your *video* is never uploaded anywhere — that stays entirely on your device.
- **Recording format depends on the browser.** The app records MP4 at 8 Mbps where the
  browser supports it, and falls back to WebM. WebM won't import into a phone's photo
  gallery, so on desktop the file lands in your downloads folder instead.
- **What you see is what you record.** Recording is vertical (9:16) by default, and the
  preview is held to exactly that shape rather than stretched to fill the screen. Phone
  screens are usually taller than 9:16, so filling them cropped the preview harder than the
  file and you framed yourself against a tighter picture than you actually got. The camera
  itself is left at its native aspect, because forcing a portrait shape on it makes some
  phones crop their own sensor and zoom in hard; the crop to vertical happens on a canvas
  instead.
- **Recording captures the camera, not the screen.** Your script never appears in the video,
  and neither does the mirror setting.
- **Long scripts and heavy accents** will drift. The matcher only searches a window around
  your current position, so if it loses you, tap Top to reset or switch to constant speed.
- **HTTPS required** when hosted, for camera and microphone access.
- **The screen wake lock can be refused.** Android grants it in Chrome, but battery saver
  overrides it, and the system reclaims it during a call or whenever the page is hidden. The
  app reclaims it on the way back and on any tap, and reports the live state under
  Settings ("Screen stays awake"), so a phone that keeps dimming can be diagnosed rather
  than guessed at.
- **Your script stays in browser storage** until you replace it, so that it survives a
  refresh. On a shared device use the Clear button on the home screen, which erases the
  script and every saved setting.
- **Turning voice pacing off is remembered.** With it off, nothing at all leaves the device.
- **Recordings are held in memory** for review and are never written to disk on their own, so
  a very long take on a phone with little free memory can be lost to the browser reclaiming
  the tab. Discarding or leaving the review screen releases the take immediately.

## How the voice matching works

The interesting part is `js/matcher.js`. Speech recognition returns messy, partial text, so
exact matching is useless. Instead:

1. Both the script and the heard text are tokenized (lowercased, punctuation and diacritics
   stripped, Unicode-aware so non-Latin scripts survive).
2. The heard words are aligned against **a window** of the script — roughly 8 words back and
   60 words forward from the current position. Searching the whole script would let a common
   word like "the" teleport you to the wrong paragraph.
3. Alignment is a greedy two-pointer walk that tolerates skips on both sides — the recognizer
   drops words, and speakers add them.
4. Individual words match on normalized Levenshtein similarity at a 0.75 threshold, so
   "channel" still matches "chanel". Digits are normalized to words, so a script that says
   "3 tools" matches a speaker saying "three tools". Filler noises ("um", "uh") are dropped
   before matching, because they dilute the ratio the confidence gate depends on.
5. A confidence gate rejects weak matches: at least two matched words, and at least half of
   what was heard. Below that, the cursor doesn't move.
6. The cursor can never move backwards, and the scroll eases toward its target rather than
   jumping, so recognizer noise doesn't make the text twitch.
7. Interim results arrive as a growing, repeatedly revised string ("hey", "hey quick", "hey
   quick one"). Feeding each one whole re-aligns the same words over and over and walks the
   cursor forward on the duplicates, so `transcript.js` decides what to actually feed: a long
   utterance goes in alone, and only a fragment too short to place borrows a few words of
   context from the previous one.
8. If nothing has matched for eight seconds, the next attempt searches a much wider window,
   so a reader who skipped a paragraph can be picked up again.

## Project layout

```
index.html        markup + all styling
js/app.js         wiring: DOM, camera, scroll loop, controls
js/matcher.js     fuzzy script-position tracking (pure logic, unit tested)
js/scroll.js      the per-frame scroll step (pure logic, unit tested)
js/transcript.js  turns recognizer results into alignable text (pure, unit tested)
js/direction.js   picks RTL or LTR per line for mixed scripts (pure, unit tested)
fonts/            self-hosted Archivo and Fraunces, so there are no third-party requests
vercel.json       CSP and security headers for the static deploy
js/speech.js      Web Speech API wrapper with continuous-restart handling
js/recorder.js    MediaRecorder capture and save-to-gallery
tests/            node --test suites, no browser required
```

The two pieces most likely to break subtly, script position and scroll position, are
pure functions with no DOM dependency, so they are tested directly in Node.

## License

MIT — see [LICENSE](LICENSE).
