# Local Hebrew speech recognition — feasibility test plan

Two tests, run in order, each with a kill gate. Neither touches the app.

The question they answer together:

> **Can this phone run local Hebrew speech recognition during an actual video
> take, and does it move the teleprompter cursor meaningfully better than our
> existing sound-pacing system?**

A candidate is viable only if it passes **all three** dimensions:

| | Dimension | Decided by |
|---|---|---|
| 1 | **Performance** — runs alongside the real recording pipeline without degrading it | TEST E |
| 2 | **Real-time behaviour** — never falls behind the speaker, acceptable end-to-end latency | TEST F, RTF gate |
| 3 | **Cursor quality** — a *noticeable* improvement over sound pacing | TEST F, three-way scoring |

Failing any one ends it. That is the point of separating them.

---

## Why this shape

TEST C settled the Web Speech API question in one round after five rounds of
guessing, because it isolated one variable and defined the verdict before
running. Same discipline here.

Two rules carried over from mistakes already made in this project:

- **Test the real pipeline, not a friendlier one.** The `voicelevel` tests used
  to open every scenario with a second of quiet room "to settle". Real takes
  begin with the reader already talking. That assumption hid a bug that made the
  whole feature useless. TEST E therefore runs the production canvas compositor
  at 8 Mbps, not a stripped-down recorder.
- **Write the pass/fail line before looking at any output.** Otherwise a result
  gets read as whatever we were hoping for.

---

## Constraints already known (before writing any code)

Read out of `vercel.json`. Not blockers today, but they shape what shipping
costs, and two are easy to discover too late:

| Constraint | Consequence |
|---|---|
| `connect-src 'self'` | **Cannot fetch models from huggingface.co.** Model files must be self-hosted on our own origin, or the CSP widened. Self-hosting is better — it keeps the "nothing leaves your device" claim literally true. |
| `script-src 'self'` | Cannot load `transformers.js` from a CDN. It must be vendored. |
| `Cross-Origin-Opener-Policy: same-origin` already set | We are **halfway to cross-origin isolation**. Adding `COEP: require-corp` unlocks `SharedArrayBuffer` and multi-threaded WASM. |
| COEP breaks third-party scripts | Direct conflict with the **Vercel Web Analytics** you asked for. Either/or. No decision needed unless both tests pass. |
| A ~250 MB download on cellular | Needs explicit consent, Cache API persistence, and a progress UI. A feature, not a footnote. |

---

## TEST E — can the phone afford concurrent inference at all?

**Question:** does sustained heavy compute degrade the actual recording — not
just on average, but **as the phone heats up**?

**Cost:** roughly half a day. No models, no downloads, no dependencies.

**Why first:** cheapest test that can kill the whole idea. If a phone already
compositing canvas frames and encoding H.264 at 8 Mbps has no headroom, no model
is small enough and TEST F is wasted effort.

### Build

New page `bench.html` + `bench.js`, same skeleton as `lab.html`: external script
(the CSP blocks inline — this has already cost us twice), timestamped log, copy
button. It imports `buildVerticalStream` from the app so it exercises **the real
compositor**, not a simplified stand-in.

### Method

1. **Baseline, 20s.** Full production pipeline: `getUserMedia` → canvas
   composite at 30fps → `MediaRecorder` at 8 Mbps. No load.
2. **Sustained baseline, 90s.** No load. Establishes what the phone does over
   time *without* us — so any decline under load is attributable, not assumed.
3. **Load sweep, 90s each.** Dense float matmul in a **Web Worker** at duty
   cycles of 25 / 50 / 75 / 100 % (X ms of work every 200 ms).
4. **Control.** One run with the same load on the **main thread**, to produce the
   evidence for why a worker is mandatory rather than assuming it.

### Measure — as a time series, sampled at 1 Hz

Every signal is recorded **per second for the whole 90 seconds**, not as a final
average. An average hides exactly the failure we are hunting: a phone that is
fine for 30 seconds and throttles at 60.

| Signal | How | Why it matters |
|---|---|---|
| Composite fps | draw calls counted per 1s bucket | video visibly stutters below ~24 |
| Encoder bitrate | bytes per 1s bucket from `ondataavailable` | a collapse means the encoder is giving up |
| Chunk jitter | gap between consecutive `ondataavailable` at `start(1000)` | healthy is ~1000 ms |
| Main-thread blocking | `PerformanceObserver` on `longtask`, plus a `setInterval(…,100)` drift counter as fallback where longtask is unsupported | predicts UI freeze |
| Dropped frames | `preview.getVideoPlaybackQuality().droppedVideoFrames` delta per bucket | independent corroboration of fps |
| `MediaRecorder` errors | `onerror` | a lost take |
| Crash | run does not complete | OOM |

**Browser-accessible indicators, logged once or cheaply** — no platform-specific
complexity for any of them:

- `navigator.hardwareConcurrency`, `navigator.deviceMemory` — logged once
- `performance.memory.usedJSHeapSize` — sampled; Chrome-only and **JS heap only**,
  so it says nothing about WASM or GPU memory. Recorded as a hint, never a gate.
- `navigator.getBattery()` — level and `charging`, sampled at 1 Hz. Battery drain
  across 90s is the closest thing to a thermal proxy the web platform offers.

**There is no thermal API on the web.** Throttling is inferred from the shape of
the fps and bitrate curves, not measured. Saying so plainly is better than
implying a precision we do not have.

### Output

A CSV plus a rendered sparkline per signal, and three summary windows:

| Window | Purpose |
|---|---|
| `0–5s` | **discarded** — warm-up, encoder still settling |
| `5–25s` (early) | what a short test would have shown |
| `70–90s` (late) | what a real 60s take actually experiences |

### Verdict — decided now, not after

Your five thresholds, unchanged:

- **FAIL** if composite fps < 24
- **FAIL** if bitrate more than 20% below baseline
- **FAIL** if chunk jitter > 1500 ms at any point
- **FAIL** on tab crash
- **FAIL** on any `MediaRecorder` error

Plus one addition, which is the whole reason for the time series — **flagging it
as mine, not yours, so you can strike it:**

- **FAIL on sustained degradation:** late-window median fps more than 10% below
  early-window median fps, *even if both stay above 24*. A phone that declines
  10% in 90 seconds has not finished declining; a 3-minute take would cross the
  floor. Same rule applied to bitrate.

**PASS** otherwise, and the output is a number: **the maximum sustained duty
cycle this phone tolerates.** That is a compute budget, which is what turns
TEST F from "is this model accurate" into "does this model fit".

**Honest limit of this test:** a hand-written matmul is not an ONNX Runtime
kernel — different memory access patterns, no SIMD tuning, no thread pool. The
budget is a **conservative ceiling estimate**, not a prediction. It is reliable
when it says *no*, and only indicative when it says *yes*.

### A fourth outcome: INVALID

Found while verifying the harness. A backgrounded page has
`requestAnimationFrame` throttled to about **half a frame per second**. The
compositor stops, the canvas produces nothing, the encoder starves, and every
threshold fails at once — while saying nothing whatsoever about compute
headroom.

On a phone this is not hypothetical: the screen dimming, a notification taking
focus, or glancing at another app all do it. Such a run is **void, not failed**.
Reporting it as FAIL would have us write off a phone that was never tested.

So the harness tracks `visibilityState` every second, holds a screen wake lock
for the duration, and reports INVALID with an explanation instead of a verdict.
A single backgrounded second voids the run — partial data here is worse than
none, because it looks plausible and is not.

### Running it on the phone

```
python3 tools/csp-server.py
```

Serves the app with `vercel.json`'s real headers, so a CSP problem shows up
locally instead of after deploying. Then open `/bench.html` on the phone,
against the deployed site or this server over the LAN.

- **E1 first** — 20s, confirms the camera and codec before committing to 90.
- **E2 next** — the 90s baseline every other run is measured against. Without
  it the bitrate threshold cannot be applied, and the harness says so rather
  than skipping it silently.
- **Screen on, phone in your hand.** Resting it on a cold desk changes the
  answer; so does letting it dim.
- **E8 is the control.** If the closing baseline is materially worse than the
  opening one, the phone never cooled between runs and the whole sweep is
  confounded by accumulated heat. The harness checks this and warns.
- **Copy CSV** at the end — that is the raw per-second series for every run.

### Kill gate

If TEST E fails, stop. Report the curves and keep sound pacing. Do not run
TEST F.

---

## TEST F — is a small Hebrew model fast enough *and* good enough?

Two independent gates, in this order: **speed first, accuracy second.** A model
that cannot keep up is disqualified regardless of how accurate it is, and
checking speed is far cheaper.

**Cost:** a day, plus recording time only you can do.

---

### Corpus — the part only you can produce

5–8 real takes, recorded **on the actual phone through the actual app**, audio
extracted from the recorded mp4, each paired with the exact script text used.
30–60s each. They must include:

- pure Hebrew
- **Hebrew and English mixed** — your real content, and the hardest case
- one noisy room
- one fast delivery

Recording these in a quiet room at a careful pace would repeat the exact mistake
the `voicelevel` tests made.

**Also capture, per take** (needed for the sound-pacing baseline, see below):
the rendered `tops` array of word offsets, `viewportHeight`, and `basePxPerSec`.
A one-line dump from the app during the recording session. Without these we
would have to *invent* the layout, and the baseline would be measuring a
teleprompter that does not exist.

---

### Ground truth — an oracle, then a human

`ivrit-ai/whisper-large-v3-turbo`, run **offline on the Mac** (the M5 Pro handles
it comfortably), produces word-level timestamps.

Pleasing detail: the 1.6 GB model that is unusable on a phone is exactly the
right tool as an offline oracle.

**It is an oracle, not truth.** Large models still mis-transcribe Hebrew, mixed
Hebrew/English, names, technical terms and fast speech — and timestamp errors
cluster in exactly those places. Scoring a small model against an unverified
large model measures *agreement between two Whispers*, which is not the question.

The process is therefore:

```
Whisper Large  →  initial alignment  →  human spot-check  →  ground truth
```

**Mandatory manual verification**, targeted rather than exhaustive:

1. Every segment where two candidate models **disagree by more than 5 words**
2. Every segment producing a **large cursor error** in any candidate
3. Every **language switch boundary** in the mixed take
4. A random 10% sample, as a check on the other three

Segments that survive spot-check are marked `verified`. Anything unverified is
excluded from the headline numbers and reported separately. **A take whose
ground truth cannot be established by hand is dropped, not guessed at.**

---

### Gate 1 — real-time factor (speed)

**Why this is a hard gate:** a model can produce excellent cursor accuracy on
recorded audio and still be useless live, because offline scoring gives it all
the time in the world. Nothing else in the plan catches that.

#### The subtlety the plan had wrong

RTF as usually written is `inference time / audio duration processed`. For a
sliding window that is **misleading**, and the error is large.

With a 5s window and a 1s hop, each inference processes 5s of audio but only
advances 1s of wall-clock. To keep up, inference must finish in under **one
second**, not five. So:

```
RTF_window   = inference_time / 5s      ← the number usually quoted
keep_up      = inference_time / 1s      ← the number that decides
```

"RTF 0.9, comfortably real-time" would be **4.5× too slow** here. Both get
reported; only `keep_up` gates.

#### Report per candidate

| Metric | Definition |
|---|---|
| Median inference time | per window, ms |
| p90 inference time | per window, ms |
| Median RTF | `inference / audio duration processed` |
| p90 RTF | " |
| **Maximum observed RTF** | the worst window |
| **Median / p90 keep-up ratio** | `inference / hop duration` |
| **Queue depth over time** | the decisive one, below |

#### Queue depth is the real answer

Ratios are a model; the empirical test is definitive. Feed audio into the
pipeline **in real time** — 1s of audio every 1s of wall-clock — and record
pending-queue depth at 1 Hz.

- Flat or oscillating near zero → keeps up
- **Monotonically growing → falls behind**, and the slope says by how much

This is measured on the phone under TEST E's load conditions, not on the Mac.
A model that keeps up on an M5 Pro tells us nothing.

#### End-to-end latency

`word spoken → in a processed window → inference → matcher → cursor moves`,
reported as median and p90, **decomposed into those four stages** — because a
fast model behind a slow window schedule still feels slow, and we need to know
which one to fix.

Note the structural floor: **a 1s hop imposes ~1s of latency before any model
runs.** That is a scheduling choice, not a model property, and it is very likely
the source of *"it has a big delay to it"*. Shrinking the hop costs compute
linearly — a direct trade against TEST E's budget, and one worth sweeping
(hop = 0.5s / 1s / 2s) rather than assuming.

#### Verdict

- **FAIL** if p90 keep-up ratio ≥ 1.0 — it falls behind under normal conditions
- **FAIL** if queue depth grows monotonically over any 60s window
- **FAIL** if p90 end-to-end latency > 1.5s
- **Proposed PASS bar: p90 keep-up ≤ 0.6**, leaving 40% headroom for thermal
  throttling and the rest of the app. Open to discussion — but the headroom has
  to be *some* number chosen before we see results, and 1.0 is not it, because a
  phone at 1.0 when cool is above 1.0 when warm.

**Candidates failing Gate 1 are not scored for accuracy.** No point.

---

### Gate 2 — cursor quality (accuracy)

#### Why WER is the wrong metric

A teleprompter does not transcribe. It advances a cursor through a script it
already knows, using a matcher that fuzzy-matches at 0.75 Levenshtein and needs
only 2 confident hits in a ±60-word window.

At 37.9% WER, `whisper-small-he` gets roughly 6 words in 10 right. Against a
known lookahead window, 6 in 10 may be plenty. As a transcriber it is useless; as
a cursor driver it might be fine. **No published benchmark answers this.**

#### Three-way comparison — all scored identically

| # | Candidate | Role |
|---|---|---|
| 1 | **`SpeechActivity` sound pacing** | **current production baseline — fully scored, not a concept** |
| 2 | Web Speech API, from a *non-recording* take | upper bound — what you get today when not recording |
| 3 | Local STT candidate | the potential recording-time replacement |

**How the sound-pacing baseline is scored.** It has no cursor of its own — it
produces `speaking: true/false`, which drives scroll position. So we run the real
thing end to end: compute RMS from the take's audio at ~60 Hz → `SpeechActivity`
→ `stepScroll()` → `nearestWordIndex(tops, focusY)`. All three are pure functions
with no DOM dependency, so Node imports the shipping code directly. That is why
the corpus must carry the real `tops` array.

Candidates 2 and 3 feed the real `ScriptMatcher` from `js/matcher.js`, also
imported directly. **We score the shipping code, not a reimplementation of it.**

#### Streaming must be simulated honestly

Whisper is fed as sliding chunks the way it would run live — **never the whole
file at once.** Feeding it complete audio would measure an accuracy we could
never achieve in a take. Hop size is swept, as above.

#### Metrics — identical across all three

| Metric | Definition | Maps to |
|---|---|---|
| **Cursor lag** | median and p90 of \|cursor − truth\| in words | *"doesn't show what is next at the right time"* |
| **Lost-track events** | \|error\| > 10 words sustained > 3s | *"it froze" / "it ran away"* |
| **Runaway rate** | wrong forward jumps per minute | worse than lagging — the reader loses their place |
| **Latency** | word spoken → cursor moves | *"it has a big delay to it"* |

#### Verdict

Absolute bar:

- median cursor lag ≤ 3 words
- p90 cursor lag ≤ 8 words
- zero lost-track events per 60s take
- acceptable runaway rate

**And a relative bar, which is the one that actually decides:** the candidate
must be **clearly, noticeably better than candidate 1.** A marginal but
statistically real improvement is a **FAIL**. It would cost ~250 MB of download,
sustained CPU, battery, thermal headroom, a CSP rework, and permanent
complexity — against something already shipping and working. The improvement has
to be one you can feel while reading, not one visible only in a table.

---

### Candidates

| # | Candidate | Purpose |
|---|---|---|
| 1 | current `SpeechActivity` sound pacing | the baseline to beat, fully scored |
| 2 | Web Speech API, non-recording take | the ceiling |
| 3 | `mike249/whisper-small-he-3` (q8) | the realistic shipping candidate |
| 4 | `mike249/whisper-tiny-he-2` (q8) | confirms the quality cliff is real, cheap to include |
| 5 | `imvladikon/wav2vec2-xls-r-300m-hebrew` | best accuracy, true streaming — **scored in PyTorch first** |

On #5: score it in PyTorch **before** paying for the ONNX export. No ONNX export
exists and no browser precedent was found. Proving the accuracy is cheap; the
export is not.

---

## Order and kill gates

```
TEST E  ──fail──▶  stop. Keep sound pacing. Report the curves.
   │
  pass  ──▶  compute budget (max sustained duty cycle)
   ▼
TEST F.1  corpus + oracle + human-verified ground truth
   │
   ▼
TEST F.2  Gate 1 — RTF / queue depth, on the phone, under load
   │
  fail ──▶ candidate disqualified. Accuracy not scored.
   │
  pass
   ▼
TEST F.3  Gate 2 — cursor quality, three-way vs sound pacing
   │
  pass ──▶ shortest path to shipping. Go to integration design.
   │
  fail (or only marginally better than sound pacing)
   ▼
TEST F.4  wav2vec2 in PyTorch, both gates
   │
  pass ──▶ only now pay for the ONNX export
   │
  fail ──▶ stop. No small Hebrew model is good enough today. Revisit in 6 months.
```

## Scope

Touches nothing in the shipped app. **No `app.js` changes, no new runtime
dependencies, no CSP or header changes — until TEST E and TEST F both produce a
clear PASS.** Everything lives in `bench.html` / `bench.js` and a `tools/`
directory. `tools/` is Node-only and never served.

The outcome of both tests is a decision, not a feature.
