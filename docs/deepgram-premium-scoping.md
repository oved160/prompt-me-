# Deepgram-backed voice tracking — build scope, for a viability check

What it would take to build cloud-based word tracking during recording,
gated behind premium or an allowlist of selected users. Written to answer one
question: **is this worth building**, before any of it is built.

---

## Why this is a different bet than the local-model chase

Everything in `docs/local-stt-progress.md` and the TEST E results was fighting
two problems at once: **is there a good enough Hebrew model**, and **does
this phone have compute headroom to run it during a recording**. The second
problem turned out to be the harder one — E8's thermal control never
recovered, meaning we couldn't even trust the phone to behave the same way
twice.

Deepgram removes the second problem entirely. The model runs on Deepgram's
servers. The phone's job shrinks to: capture microphone audio, send bytes over
a WebSocket. That's a trivial, constant, tiny CPU cost — nothing like running
an ONNX model continuously. **The entire TEST E investigation becomes
irrelevant to this path.**

It also sidesteps the specific bug TEST C found. That bug wasn't "cloud STT
doesn't work during a recording" — it was Android Chrome's *built-in*
recognizer specifically going silent once `MediaRecorder` holds the microphone
(confirmed: it fires `onaudiostart`/`onsoundstart`/`onspeechstart`, so it has
the mic, then returns zero results for the rest of the take). Deepgram
doesn't touch that recognizer. We'd tap the mic ourselves via the Web Audio
API — the same tap point [`prepareLevelPacing()`](../js/app.js) already uses
today, concurrently with `MediaRecorder`, in production, right now. That
concurrent-tap path is proven on this exact device architecture; we'd just be
sending real PCM samples somewhere instead of computing RMS from them.

**What's genuinely new risk:** level-pacing only needs to know "is there
sound" — it tolerates dropped samples and artifacts that would be invisible in
an RMS calculation but could matter to a real ASR engine. That gap is untested
and is the first thing the spike below checks.

---

## Concrete technical facts (fetched from Deepgram's docs, not assumed)

| | |
|---|---|
| WebSocket endpoint | `wss://api.deepgram.com/v1/listen` |
| Audio encoding | `encoding=linear16`, mono, needs a `sample_rate` param — exact recommended rate for browser-captured audio wasn't documented publicly; confirm empirically in the spike (16kHz mono is the common default for speech models generally) |
| Hebrew | Production-grade on Nova-3, RTL-aware, added specifically for Hebrew/Persian/Urdu |
| Result shape | JSON messages, `is_final` boolean, `channel.alternatives[0].transcript`, per-word `start`/`end`/`confidence` — richer than Web Speech API's output, and already includes word-level timing our matcher doesn't currently get for free |
| Auth for a browser client | `POST https://api.deepgram.com/v1/auth/grant` (server-side, permanent key required) returns a short-lived JWT. **Default TTL is only 30 seconds** — request a longer `ttl_seconds` explicitly for anything resembling a real take; max isn't documented, confirm empirically |
| Pricing | ~$0.0048–0.0077/min pay-as-you-go, billed per second, $200 free credit on signup, no minimum commitment (the $4,000/yr Growth plan is a later optimization, not a starting requirement) |

---

## The spike: answer viability before building anything else

Same discipline as `lab.html`'s TEST A–D and `bench.html`'s TEST E — an
isolated page, nothing wired into the shipped app, a small number of runs with
the verdict decided before looking at the result.

**TEST G — Deepgram live audio, concurrent with a real recording.**

1. New page, `dg-lab.html` / `dg-lab.js`, same skeleton as `lab.html`.
2. Start a real `MediaRecorder` recording (same settings as the shipping
   `Recorder`), exactly like TEST C did.
3. Concurrently, tap the mic track via an `AudioWorkletNode` (not
   `ScriptProcessorNode` — deprecated), convert Float32 samples to 16-bit PCM,
   and stream them over a WebSocket straight to Deepgram.
4. For this spike only: a personal API key typed into the page by hand,
   **never committed**, used directly (skip the token-minting server for now
   — that's a real requirement before shipping, not before testing viability).
5. Log every message with a timestamp, same style as the other labs: connect,
   first audio sent, first interim result, first final result, any WebSocket
   error or close code.
6. Talk continuously in Hebrew for 30–60 seconds while recording.

**Verdict, decided now:**

- **PASS** if final transcripts arrive continuously throughout the recording,
  with latency that feels usable for cursor-driving (rough target: under
  ~1s from word spoken to transcript arriving — Deepgram advertises under
  300ms server-side, so most of any lag would be our own audio-buffering
  choices).
- **FAIL** if results stop arriving once `MediaRecorder` starts (would mean
  the concurrent-tap assumption doesn't hold for full-fidelity audio the way
  it does for level-pacing), or if the WebSocket drops mid-recording.

This costs about a dollar in Deepgram credits (or nothing, inside the $200
signup credit) and half a day to build. It's the single test that actually
answers "is this viable," which is what was asked for.

---

## If TEST G passes: what shipping it actually takes

1. **Server-side token endpoint** — one new file, `api/deepgram-token.js`,
   a Vercel serverless function. Holds the real API key as an environment
   variable (never in client code or git), calls Deepgram's `/v1/auth/grant`
   server-side, returns the short-lived token to the client. This is the
   first server-side code this project has ever needed — everything else has
   been a static site. Small, but a real architectural first.
   - Should also enforce **who can request a token** (an allowlist check, a
     signed session, or just a shared secret for a small pilot) — without
     this, anyone who finds the endpoint can mint tokens and spend your
     Deepgram credits.
2. **`js/deepgram.js`** — a new listener module shaped like `SpeechListener`
   (`onResult`/`onStatus`/`onError`), so it plugs into the *existing*
   `ScriptMatcher` and `TranscriptFeeder` pipeline with minimal changes
   elsewhere. The matching logic, confidence gating, and cursor advancement
   are all already built and tested — this only replaces where the transcript
   comes from.
3. **Audio capture** — the `AudioWorkletNode` tap proven in the spike, wired
   to the same mic track `prepareLevelPacing()` already uses.
4. **Token lifetime** — request a `ttl_seconds` covering the longest
   reasonable take (confirm the real ceiling; if there is a hard cap below
   that, add a refresh-and-reconnect cycle before expiry as a fallback).
5. **CSP change** — `connect-src 'self'` currently blocks a WebSocket to
   Deepgram entirely. Needs `wss://api.deepgram.com` added explicitly. This is
   a small, known, one-line change — not the COOP/COEP-vs-Analytics conflict
   the local-model path ran into.
6. **Feature gate** — same mechanism already shipped:
   `VOICE_TRACKING_ENABLED`-style flag, this time keyed to an allowlist of
   user IDs or a build flag, not a blanket premium check. That's the cheapest
   way to pilot with a handful of real users before any billing exists.

---

## Cost, at pilot scale

20 selected users, 10 takes/month each, ~90s/take ≈ 300 minutes/month total ≈
**$1.50–$2.30/month** at pay-as-you-go rates. Trivial for a pilot. The real
cost conversation only starts to matter at real scale, which is exactly when a
premium tier should already be funding it.

---

## What stays true either way

None of this touches the MVP that just shipped. `VOICE_TRACKING_ENABLED`
stays `false` by default; this is a second, separate flag for a cloud-backed
path, built and tested independently, merged only once TEST G has a verdict.
