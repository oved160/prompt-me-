# Local Hebrew speech recognition — where we are, and where we're stuck

Status snapshot for cross-checking against other tools/models. Written so it
stands alone — no need to have read the rest of this conversation.

## The problem we're solving

**Prompt Me** is a voice-controlled teleprompter (vanilla JS, no framework,
deployed on Vercel). It uses Chrome's Web Speech API to track which word the
reader is on and auto-scroll the script.

**Confirmed dead end:** Web Speech API cannot do word tracking *while
recording video* on Android Chrome. An isolated test harness (`lab.html`,
TEST A/B/C) proved the recognizer opens the mic, hears audio (`onaudiostart`,
`onsoundstart`, `onspeechstart` all fire), then returns **zero results and zero
errors** for the whole recording. Chrome transcribes on Google's servers, and
that channel goes silent whenever `MediaRecorder` is active — silently, with no
error to catch. This is a platform limitation, not a bug in our code.

**Current fallback, shipped and working:** sound-level pacing during
recording (`js/voicelevel.js`) — advances the script when the mic is loud,
holds when quiet. It doesn't know *which* word is spoken, only that someone is
talking. Word tracking returns after the recording stops.

**The open question:** can a *local* (on-device, offline) Hebrew speech model
replace sound-pacing during recording, giving real word tracking without
sending audio anywhere?

## Hard constraints

- **Hebrew**, with real Hebrew/English code-switching (the target user mixes
  languages while reading marketing scripts).
- **Must work on Android Chrome**, phone hardware, not desktop.
- **Must run concurrently with `MediaRecorder`** recording 1080p vertical
  video at 8 Mbps.
- **Must be genuinely local** — no server round-trip, that's the whole point
  of not using Web Speech API's cloud path.
- **CSP is strict** (`vercel.json`): `connect-src 'self'` blocks fetching
  models from huggingface.co directly (would need self-hosting the model
  files); `script-src 'self'` blocks CDN-loaded JS (transformers.js would need
  vendoring). `COOP: same-origin` is already set; adding `COEP: require-corp`
  (needed for multi-threaded WASM) would break the Vercel Web Analytics
  snippet the user also wants — an unresolved either/or, not yet decided.
- **Do not introduce Whisper as a live/production dependency without proof it
  fits.** (User's earlier explicit instruction, in the context of ruling out
  a large rewrite — still the operating constraint.)

## What we researched: no clean answer exists yet

| Candidate | Hebrew model? | Verdict |
|---|---|---|
| **Vosk** | ❌ None. ~25 languages, Hebrew absent from the [official list](https://alphacephei.com/vosk/models). | Dead end. |
| **sherpa-onnx** | ❌ None in any streaming family (Zipformer/Paraformer). | Dead end. |
| **Moonshine** | ❌ English-only by design. | Dead end. |
| **wav2vec2-xls-r-300m-hebrew** ([imvladikon](https://huggingface.co/imvladikon/wav2vec2-xls-r-300m-hebrew)) | ✅ 17–23% WER, genuinely streaming (CTC, frame-synchronous). | **Best accuracy candidate, but no ONNX export exists and no browser precedent was found anywhere.** We'd be first. |
| **whisper-small-he-3** ([mike249](https://huggingface.co/mike249/whisper-small-he-3)) | ✅ 37.9% WER | Whisper's 30s-window architecture is not naturally streaming — needs sliding-window chunking, imposing a latency floor (~1s per hop) no matter how fast the model runs. |
| **whisper-tiny-he-2** | ✅ 55.9% WER | Too inaccurate even for cursor-driving (see below). |
| **ivrit-ai/whisper-large-v3-turbo** (best Hebrew quality; [unofficial ONNX export](https://huggingface.co/instush/ivrit-whisper-large-v3-turbo-timestamped-onnx) exists) | ✅ SOTA | 1.6 GB, its own model card says "too large for WASM on typical hardware," WebGPU-only. Not viable on a phone. Good as an **offline ground-truth oracle** on a Mac, not as the on-device model. |

**Key reframing that keeps whisper-small-he-3 alive despite 37.9% WER:** a
teleprompter doesn't need to transcribe — it needs to advance a cursor through
a script it already has, using fuzzy matching (`js/matcher.js`, Levenshtein
≥0.75, needs only 2 confident hits in a ±60-word window). 6-in-10 words right
might be plenty for that; nobody's published benchmark answers this, because
it's not the question WER measures. This needs to be tested directly, not
assumed either way.

## TEST E: does the phone even have compute headroom? — in progress, currently confounded

Built a device-side harness (`bench.html`) that runs the *real* recording
pipeline (same crop math, same `MediaRecorder` settings as the shipping app)
alongside a synthetic CPU load (dense matmul in a Web Worker), at 0/25/50/75/
100% duty cycle, sampling fps/bitrate/jitter once a second for 90 seconds.

**Two false alarms found and fixed along the way** (both confirmed via
hand-calculation against the raw per-second CSV before touching code):

1. This phone's hardware H.264 encoder doesn't flush data every 1 second like
   `MediaRecorder.start(1000)` requests — it bursts every ~3.5s, even at rest
   with zero load. Fixed a jitter threshold that was failing on normal
   behavior, and a bitrate-smoothing bug that fabricated a "47% decline" where
   the real number (computed from raw bytes/time) was 14%.
2. Bitrate naturally swings **14% → 0.3% → 15% → 15%** across four separate
   zero/light-load baseline sessions on the same phone, same test — purely
   from whatever was in front of the camera. Bitrate cannot be used as a
   throttling signal on its own; it's now informational only. **fps** is the
   metric that actually tracks compute headroom, and it stayed rock-solid
   (27–31, never near the 24 floor) through 25%, 50%, 75%, and 100% load.

**Real findings, holding up under scrutiny:**

- **25% and 50% load: clean pass**, bitrate ≈ baseline, fps untouched.
- **75% and 100% load: bitrate collapses hard** (8272 → ~1900 kbps, a 77%
  drop) while fps stays fine — the phone silently trades away video quality
  rather than dropping frames. Reproducible: 1916 vs 1918 kbps between the two
  runs, not noise.
- **Main-thread control (50% load, same as passing E4, but not in a Worker)
  fails outright**: fps min 15.0, chunk jitter 5401ms. This is a hard,
  unambiguous confirmation that **any real inference must run in a Worker**,
  not a nice-to-have.
- **The thermal control (E8: zero load, run last) did NOT recover** — it
  still showed the same ~1900kbps collapse as E5/E6/E7, instead of returning
  to E2's 8272kbps opening baseline.

**This last point is where we're actually stuck right now:** because E8 never
recovered, we can't yet say "75% load causes the collapse." It's equally
consistent with "~12 minutes of continuous camera+encoder use causes this,"
independent of the synthetic load level — thermal accumulation, Android's own
power-saving behavior kicking in after sustained heavy use, or something else
entirely. The whole duty-cycle sweep is confounded by heat/state that never
reset between runs, which is exactly the failure mode the plan's own thermal
control was built to catch — and it caught it.

**Immediate next step (in progress, not yet done):** phone is resting
(screen off, out of hand) for several minutes, then re-running the E2
baseline cold. If bitrate recovers near 8000kbps, the collapse was
thermal/cumulative and the sweep needs re-running with real cooldowns between
levels (the harness has a "run with cooldowns" mode built for this,
`COOLDOWN_S = 30`, possibly needs to be longer). If it does *not* recover even
after resting, that points to something more persistent — worth investigating
before concluding anything about compute budget.

## What we have not yet tested at all

- **TEST F is not started**: no real-time-factor / inference-latency
  measurement, no cursor-quality scoring against the shipping `ScriptMatcher`,
  no corpus recorded, no ground truth established. Everything above is purely
  "can the phone afford compute headroom," not "does any model actually work
  well enough."
- No attempt yet to run an actual ONNX model (Whisper or wav2vec2) on this
  phone — TEST E only used a synthetic matmul stand-in, which is a
  conservative proxy, not a real inference kernel. A real ONNX Runtime kernel
  may be meaningfully more efficient per unit of "load" than this synthetic
  benchmark assumes, which cuts in favor of more headroom existing than TEST E
  alone suggests.
- No investigation yet into whether Android's power-saving mode, battery
  saver, or per-app CPU governor behavior is the actual cause of the E5-E8
  collapse, independent of anything in this codebase.

## Open questions worth another tool's perspective on

1. **Is there a Hebrew-capable local ASR option we haven't found?** Searched
   Vosk, sherpa-onnx, Whisper family, Moonshine, wav2vec2/MMS. Did not deeply
   investigate: Meta's MMS-1B-all (1107-language wav2vec2, includes Hebrew,
   1B params — likely too large, not evaluated), NeMo/Parakeet (English-only
   as far as we found, not confirmed), any 2025-2026-era small multilingual
   streaming model we may not know about yet given a knowledge cutoff.
2. **Is the E5-E8 bitrate collapse a known Android/Chrome behavior** (thermal
   throttling of the hardware encoder specifically, distinct from CPU
   throttling; Android's Doze/App Standby; Chrome's own resource governor)
   that has documented recovery times or triggers we should design around
   rather than discover experimentally?
3. **Is there a fundamentally different architecture** we haven't considered
   — e.g., doing inference at a much lower duty cycle than continuous
   streaming (batch every N seconds instead of sliding-window), offloading to
   a native Android capability via a Trusted Web Activity or similar (would
   break the "just a website" constraint, but worth knowing the tradeoff), or
   accepting a hybrid where local STT only runs during natural pauses rather
   than continuously?
