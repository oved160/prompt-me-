/**
 * TEST E — can this phone afford to run speech recognition during a take?
 *
 * It answers that by running the real recording pipeline and adding a
 * controllable compute load beside it, then watching what the recording does.
 *
 * Everything is sampled once a second for the whole run. An average would hide
 * the exact failure worth hunting: a phone that is fine for thirty seconds and
 * throttles at sixty. A ninety second run with a per-second series shows the
 * shape; a single number at the end does not.
 *
 * Nothing here touches the app.
 */
import { coverCrop, verticalSize } from './js/framing.js';
import { pickMimeType } from './js/recorder.js';
import { createLoad, FLOPS_PER_ITERATION } from './bench-load.js';
import {
    WARMUP_S, LIMITS, median, windowOf, judge as judgeRun, deriveBitrate,
} from './bench-analysis.js';

const dom = {};
for (const id of ['log', 'verdict', 'charts', 'runs', 'preview', 'copy', 'csv', 'runall']) {
    dom[id] = document.getElementById(id);
}

let lines = [];
let t0 = 0;
/** Every completed run, keyed by id, so later runs can be judged against the baseline. */
const results = new Map();

function log(msg) {
    const t = ((performance.now() - t0) / 1000).toFixed(1).padStart(6, ' ');
    lines.push(`${t}s  ${msg}`);
    dom.log.textContent = lines.join('\n');
    dom.log.scrollTop = dom.log.scrollHeight;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The camera, held once across every run
// ---------------------------------------------------------------------------

let camera = null;      // the raw getUserMedia stream
let cameraVideo = null; // the element the compositor draws from

async function acquireCamera() {
    if (camera) return camera;
    log('requesting camera and microphone…');
    camera = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: { echoCancellation: true, noiseSuppression: true },
    });
    cameraVideo = document.createElement('video');
    cameraVideo.muted = true;
    cameraVideo.playsInline = true;
    cameraVideo.srcObject = camera;
    await cameraVideo.play();
    // videoWidth is 0 until the first frame decodes, and the compositor sizes
    // itself from it.
    for (let i = 0; i < 100 && !cameraVideo.videoWidth; i++) await sleep(50);
    const track = camera.getVideoTracks()[0];
    const s = track.getSettings();
    log(`camera ready: ${cameraVideo.videoWidth}x${cameraVideo.videoHeight} @ ${s.frameRate || '?'}fps`);
    return camera;
}

// ---------------------------------------------------------------------------
// The compositor
//
// This is the app's own draw loop, rebuilt here rather than imported. The crop
// maths IS the app's — coverCrop and verticalSize come straight out of
// js/framing.js, which is where all the subtlety lives. The dozen lines of
// requestAnimationFrame around them are reproduced because buildVerticalStream
// is private to app.js and bound to its DOM, and the plan forbids editing app.js
// before this test has produced a verdict. Exporting it would have been tidier;
// touching the shipped file to run a test on it would not.
// ---------------------------------------------------------------------------

function startCompositor() {
    const srcW = cameraVideo.videoWidth;
    const srcH = cameraVideo.videoHeight;
    const { width, height } = verticalSize(srcW, srcH);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });

    let handle = null;
    let draws = 0;

    const draw = () => {
        const w = cameraVideo.videoWidth || srcW;
        const h = cameraVideo.videoHeight || srcH;
        if (w && h) {
            const { sx, sy, sw, sh } = coverCrop(w, h, width, height);
            ctx.drawImage(cameraVideo, sx, sy, sw, sh, 0, 0, width, height);
            draws++;
        }
        handle = requestAnimationFrame(draw);
    };
    draw();

    const stream = canvas.captureStream(30);
    camera.getAudioTracks().forEach((t) => stream.addTrack(t));

    return {
        stream,
        size: `${width}x${height}`,
        get draws() { return draws; },
        stop() { if (handle !== null) cancelAnimationFrame(handle); handle = null; },
    };
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.label
 * @param {number} opts.seconds
 * @param {number} opts.duty        0..1 fraction of each 200ms window spent computing
 * @param {'worker'|'main'|'none'} opts.where
 */
async function runOne({ id, label, seconds, duty = 0, where = 'none' }) {
    await acquireCamera();

    const comp = startCompositor();
    dom.preview.srcObject = comp.stream;
    await dom.preview.play().catch(() => {});

    const mimeType = pickMimeType();
    log(`${label}: ${comp.size}, ${mimeType || 'NO SUPPORTED MIME TYPE'}`);
    if (!mimeType) { comp.stop(); throw new Error('no supported mime type'); }

    // Identical settings to js/recorder.js. Own data handler, because the real
    // Recorder buffers chunks without timestamps and the timestamps are the
    // measurement.
    const recorder = new MediaRecorder(comp.stream, {
        mimeType,
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 128_000,
    });

    const mrErrors = [];
    const chunkGaps = [];
    let lastChunkAt = performance.now();
    let bytesSinceSample = 0;
    let totalBytes = 0;
    let chunks = 0;

    recorder.ondataavailable = (e) => {
        const now = performance.now();
        chunkGaps.push({ at: now, gap: now - lastChunkAt });
        lastChunkAt = now;
        if (e.data && e.data.size) {
            bytesSinceSample += e.data.size;
            totalBytes += e.data.size;
            chunks++;
        }
    };
    recorder.onerror = (e) => {
        const msg = String(e.error || e.name || e);
        mrErrors.push(msg);
        log(`MediaRecorder ERROR: ${msg}`);
    };

    // --- main-thread blocking, two ways ------------------------------------
    // longtask is the proper measure. The interval drift counter is a fallback
    // for engines that do not ship the entry type, and a cross-check where they
    // do: two independent signals disagreeing is worth knowing about.
    let longTaskMs = 0;
    let longTaskMax = 0;
    let longTaskSupported = false;
    let observer = null;
    try {
        observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                longTaskMs += entry.duration;
                longTaskMax = Math.max(longTaskMax, entry.duration);
            }
        });
        observer.observe({ entryTypes: ['longtask'] });
        longTaskSupported = true;
    } catch {
        // Not supported here; the drift counter carries the signal alone.
    }

    let driftMax = 0;
    let driftExpected = performance.now() + 100;
    const driftTimer = setInterval(() => {
        const now = performance.now();
        driftMax = Math.max(driftMax, now - driftExpected);
        driftExpected = now + 100;
    }, 100);

    // --- the load -----------------------------------------------------------
    let worker = null;
    let mainLoad = null;
    let mainLoadTimer = null;
    let workerSample = { iterations: 0, busyMs: 0, gflops: 0 };
    let mainIterations = 0;
    let mainBusyMs = 0;

    if (where === 'worker' && duty > 0) {
        worker = new Worker('./bench-worker.js', { type: 'module' });
        worker.onmessage = (e) => {
            if (e.data.type === 'sample') workerSample = e.data;
            if (e.data.type === 'started') log(`worker load: ${e.data.onMs}ms per ${e.data.periodMs}ms window`);
        };
        worker.postMessage({ type: 'start', duty });
    } else if (where === 'main' && duty > 0) {
        mainLoad = createLoad();
        const onMs = Math.round(200 * duty);
        log(`MAIN-THREAD load (control run): ${onMs}ms per 200ms window`);
        mainLoadTimer = setInterval(() => {
            const started = performance.now();
            mainIterations += mainLoad.burn(onMs);
            mainBusyMs += performance.now() - started;
        }, 200);
    }

    // --- battery, sampled where available -----------------------------------
    let battery = null;
    try { battery = await navigator.getBattery?.(); } catch { /* not exposed here */ }
    const batteryStart = battery ? battery.level : null;

    // --- keep the screen on --------------------------------------------------
    // A phone that dims mid-run throttles rAF, the compositor stops, and the
    // whole run measures nothing. The app already holds a wake lock during a
    // take; a test of the app's recording pipeline should hold one too, or it is
    // not testing the same conditions.
    let wakeLock = null;
    try { wakeLock = await navigator.wakeLock?.request('screen'); }
    catch { log('no wake lock available; keep the screen awake yourself'); }

    // Backgrounding invalidates a run rather than failing it. Tracked per second
    // so a brief interruption is visible in the CSV rather than averaged away.
    let hiddenNow = document.visibilityState === 'hidden';
    const onVisibility = () => { if (document.visibilityState === 'hidden') hiddenNow = true; };
    document.addEventListener('visibilitychange', onVisibility);

    // --- go -----------------------------------------------------------------
    const samples = [];
    let quality = dom.preview.getVideoPlaybackQuality?.();
    let lastTotalFrames = quality ? quality.totalVideoFrames : 0;
    let lastDropped = quality ? quality.droppedVideoFrames : 0;
    let lastDraws = 0;
    const fpsSource = quality ? 'presented frames' : 'draw calls (fallback)';

    recorder.start(1000);
    const runStart = performance.now();
    lastChunkAt = runStart;
    let lastSampleAt = runStart;
    log(`${label}: recording ${seconds}s, fps measured from ${fpsSource}`);

    while (performance.now() - runStart < seconds * 1000) {
        await sleep(1000);
        const now = performance.now();
        // Normalised by real elapsed time, not by the nominal one second. Under
        // heavy load this sampler drifts too, and dividing by 1000 anyway would
        // quietly understate every rate exactly when it matters most.
        const dt = (now - lastSampleAt) / 1000;
        lastSampleAt = now;
        const t = (now - runStart) / 1000;

        quality = dom.preview.getVideoPlaybackQuality?.();
        let fps;
        let dropped = 0;
        if (quality) {
            fps = (quality.totalVideoFrames - lastTotalFrames) / dt;
            dropped = quality.droppedVideoFrames - lastDropped;
            lastTotalFrames = quality.totalVideoFrames;
            lastDropped = quality.droppedVideoFrames;
        } else {
            // No playback-quality API: fall back to the draw loop, capped at the
            // capture rate, since drawing faster than 30fps does not put more
            // frames into the stream.
            fps = Math.min(30, (comp.draws - lastDraws) / dt);
        }
        lastDraws = comp.draws;

        // A stall has to show up while it is happening. Counting only completed
        // gaps would leave a five second freeze invisible until it ended.
        const gapsThisBucket = chunkGaps.filter((g) => g.at > now - dt * 1000).map((g) => g.gap);
        const jitter = Math.max(now - lastChunkAt, ...(gapsThisBucket.length ? gapsThisBucket : [0]));

        if (worker) worker.postMessage({ type: 'sample' });

        samples.push({
            t: +t.toFixed(2),
            dt: +dt.toFixed(3),
            fps: +fps.toFixed(1),
            droppedFrames: dropped,
            bytes: bytesSinceSample,
            maxJitterMs: Math.round(jitter),
            longTaskMs: Math.round(longTaskMs),
            longTaskMaxMs: Math.round(longTaskMax),
            driftMaxMs: Math.round(driftMax),
            heapMb: performance.memory
                ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
            batteryLevel: battery ? battery.level : null,
            hidden: hiddenNow || document.visibilityState === 'hidden',
            loadGflops: worker ? +(workerSample.gflops / dt).toFixed(2)
                : (mainLoad ? +((mainIterations * FLOPS_PER_ITERATION) / 1e9 / dt).toFixed(2) : 0),
            loadBusyMs: worker ? Math.round(workerSample.busyMs) : Math.round(mainBusyMs),
        });

        bytesSinceSample = 0;
        longTaskMs = 0;
        longTaskMax = 0;
        driftMax = 0;
        mainIterations = 0;
        mainBusyMs = 0;
        hiddenNow = false; // sticky within a bucket only, so the CSV shows when
    }

    // --- stop ---------------------------------------------------------------
    recorder.stop();
    clearInterval(driftTimer);
    clearInterval(mainLoadTimer);
    observer?.disconnect();
    if (worker) { worker.postMessage({ type: 'stop' }); setTimeout(() => worker.terminate(), 200); }
    comp.stop();
    document.removeEventListener('visibilitychange', onVisibility);
    try { await wakeLock?.release(); } catch { /* already gone */ }
    dom.preview.srcObject = null;
    await sleep(300);

    deriveBitrate(samples);

    const run = {
        id, label, seconds, duty, where, samples, mrErrors, chunks, totalBytes,
        fpsSource, longTaskSupported,
        batteryDrop: battery && batteryStart !== null
            ? +((batteryStart - battery.level) * 100).toFixed(2) : null,
        finishedAt: Date.now(),
    };
    results.set(id, run);
    log(`${label}: ${chunks} chunks, ${(totalBytes / 1048576).toFixed(1)} MB`);
    return run;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** The 90s no-load run is what every loaded run is measured against. */
const judge = (run) => judgeRun(run, results.get('baseline90') ?? null);

function describe(run) {
    const v = judge(run);
    if (v.invalid.length) {
        return `INVALID — ${run.label}\n${v.invalid.map((i) => `  ! ${i}`).join('\n')}`;
    }
    const head = v.fails.length
        ? `FAIL — ${run.label}`
        : `PASS — ${run.label}`;
    const body = [];
    body.push(`fps min ${v.minFps.toFixed(1)} · bitrate ${v.kbps}kbps · jitter max ${v.maxJitter}ms`);
    if (v.early && v.late) {
        body.push(`early ${v.early.fps.toFixed(1)}fps/${v.early.kbps}kbps → late ${v.late.fps.toFixed(1)}fps/${v.late.kbps}kbps`);
    }
    if (run.duty > 0) {
        const w = windowOf(run, [WARMUP_S, run.seconds]);
        body.push(`load ${(run.duty * 100).toFixed(0)}% on ${run.where}, ~${w ? w.gflops.toFixed(1) : '?'} GFLOP/s`);
    }
    if (run.batteryDrop !== null) body.push(`battery −${run.batteryDrop}% over the run`);
    if (!run.longTaskSupported) body.push('longtask unsupported here; drift counter only');
    for (const f of v.fails) body.push(`  ✗ ${f}`);
    for (const n of v.notes) body.push(`  · ${n}`);
    return `${head}\n${body.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function sparkline(run, key, { floor = null, label = '' } = {}) {
    const values = run.samples.map((s) => s[key] ?? 0);
    if (!values.length) return '';
    const W = 300;
    const H = 44;
    const max = Math.max(...values, floor ?? 0) * 1.1 || 1;
    const pts = values.map((v, i) => {
        const x = (i / Math.max(1, values.length - 1)) * W;
        const y = H - (v / max) * H;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const floorY = floor === null ? null : H - (floor / max) * H;
    return `
        <div class="spark">
            <div class="sparklabel">${label} <span>peak ${Math.max(...values).toFixed(0)}</span></div>
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label}">
                ${floorY !== null ? `<line x1="0" y1="${floorY.toFixed(1)}" x2="${W}" y2="${floorY.toFixed(1)}" class="limit"/>` : ''}
                <polyline points="${pts}"/>
            </svg>
        </div>`;
}

function renderRun(run) {
    const v = judge(run);
    const state = v.invalid.length ? 'invalid' : (v.fails.length ? 'fail' : 'pass');
    const mark = { invalid: '!', fail: '✗', pass: '✓' }[state];
    const card = document.createElement('div');
    card.className = `card ${state}`;
    card.innerHTML = `
        <h2>${mark} ${run.label}</h2>
        <pre class="summary">${describe(run).split('\n').slice(1).join('\n')}</pre>
        ${sparkline(run, 'fps', { floor: LIMITS.minFps, label: 'composite fps' })}
        ${sparkline(run, 'kbps', { label: 'bitrate kbps' })}
        ${sparkline(run, 'maxJitterMs', { floor: LIMITS.maxJitterMs, label: 'chunk jitter ms' })}
        ${sparkline(run, 'longTaskMaxMs', { label: 'longest task ms' })}
    `;
    dom.runs.prepend(card);
}

function toCsv() {
    const rows = ['run,duty,where,t,dt,fps,droppedFrames,bytes,kbps,maxJitterMs,longTaskMs,longTaskMaxMs,driftMaxMs,heapMb,batteryLevel,loadGflops,loadBusyMs,hidden'];
    for (const run of results.values()) {
        for (const s of run.samples) {
            rows.push([run.id, run.duty, run.where, s.t, s.dt, s.fps, s.droppedFrames,
                s.bytes, s.kbps, s.maxJitterMs, s.longTaskMs, s.longTaskMaxMs, s.driftMaxMs,
                s.heapMb ?? '', s.batteryLevel ?? '', s.loadGflops, s.loadBusyMs,
                s.hidden ? 1 : 0].join(','));
        }
    }
    return rows.join('\n');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const RUNS = [
    { id: 'baseline20', label: 'E1 · baseline, 20s, no load', seconds: 20, duty: 0, where: 'none' },
    { id: 'baseline90', label: 'E2 · baseline, 90s, no load', seconds: 90, duty: 0, where: 'none' },
    { id: 'duty25', label: 'E3 · 25% load, worker, 90s', seconds: 90, duty: 0.25, where: 'worker' },
    { id: 'duty50', label: 'E4 · 50% load, worker, 90s', seconds: 90, duty: 0.5, where: 'worker' },
    { id: 'duty75', label: 'E5 · 75% load, worker, 90s', seconds: 90, duty: 0.75, where: 'worker' },
    { id: 'duty100', label: 'E6 · 100% load, worker, 90s', seconds: 90, duty: 1.0, where: 'worker' },
    { id: 'mainthread', label: 'E7 · 50% load on MAIN THREAD, 90s', seconds: 90, duty: 0.5, where: 'main' },
    { id: 'baselineAfter', label: 'E8 · baseline again, 90s (thermal control)', seconds: 90, duty: 0, where: 'none' },
];

let busy = false;

function setBusy(on) {
    busy = on;
    for (const b of document.querySelectorAll('button')) b.disabled = on;
}

async function launch(spec) {
    if (busy) return;
    setBusy(true);
    if (!lines.length) {
        t0 = performance.now();
        log(`ua: ${navigator.userAgent}`);
        log(`cores: ${navigator.hardwareConcurrency ?? '?'} · deviceMemory: ${navigator.deviceMemory ?? '?'}GB`);
        log(`thresholds: fps>=${LIMITS.minFps}, bitrate>=${Math.round(LIMITS.bitrateFloorRatio * 100)}% of baseline, ` +
            `jitter<=${LIMITS.maxJitterMs}ms, decline<=${Math.round((1 - LIMITS.maxDeclineRatio) * 100)}%`);
        log('note: the web platform exposes no thermal sensor. Throttling is inferred');
        log('      from the shape of the fps and bitrate curves, not measured.');
    }
    dom.verdict.textContent = `${spec.label} — running for ${spec.seconds}s. Hold the phone as you would while reading.`;
    try {
        const run = await runOne(spec);
        renderRun(run);
        dom.verdict.textContent = describe(run);
        log(describe(run).split('\n')[0]);
    } catch (err) {
        log(`RUN THREW: ${err.name}: ${err.message}`);
        dom.verdict.textContent = `${spec.label} threw ${err.name}: ${err.message}`;
    } finally {
        setBusy(false);
    }
}

for (const spec of RUNS) {
    const b = document.createElement('button');
    b.textContent = spec.label;
    b.className = spec.duty === 0 ? 'run baseline' : 'run';
    b.onclick = () => launch(spec);
    document.getElementById('buttons').appendChild(b);
}

/**
 * The whole sequence, with a cooldown between runs.
 *
 * Thermal state carries over. Running 25% straight into 50% would start the
 * second run on a phone the first one warmed up, and the sweep would measure
 * accumulated heat rather than duty cycle. The gaps are why E8 exists too: if
 * the closing baseline is much worse than the opening one, the sweep is
 * confounded and we get to know that rather than assume otherwise.
 */
const COOLDOWN_S = 30;
dom.runall.onclick = async () => {
    if (busy) return;
    const total = RUNS.reduce((s, r) => s + r.seconds + COOLDOWN_S, 0);
    if (!confirm(`Runs every test back to back: about ${Math.round(total / 60)} minutes, ` +
                 `with ${COOLDOWN_S}s cooldowns. Keep the screen on and the phone in your hand. Start?`)) return;
    for (const spec of RUNS) {
        await launch(spec);
        if (spec !== RUNS[RUNS.length - 1]) {
            setBusy(true);
            for (let s = COOLDOWN_S; s > 0; s--) {
                dom.verdict.textContent = `cooling down — ${s}s until ${RUNS[RUNS.indexOf(spec) + 1].label}`;
                await sleep(1000);
            }
            setBusy(false);
        }
    }
    const opening = results.get('baseline90');
    const closing = results.get('baselineAfter');
    if (opening && closing) {
        const a = median(opening.samples.filter((s) => s.t >= WARMUP_S).map((s) => s.fps));
        const b = median(closing.samples.filter((s) => s.t >= WARMUP_S).map((s) => s.fps));
        log(`thermal control: opening baseline ${a.toFixed(1)}fps, closing ${b.toFixed(1)}fps`);
        if (b < a * 0.95) {
            log('WARNING: the phone did not return to its opening baseline. The sweep is');
            log('         confounded by accumulated heat; re-run cold with longer cooldowns.');
        }
    }
};

dom.copy.onclick = async () => {
    try {
        await navigator.clipboard.writeText(lines.join('\n'));
        dom.copy.textContent = 'Copied';
        setTimeout(() => { dom.copy.textContent = 'Copy log'; }, 2500);
    } catch {
        dom.copy.textContent = 'Select the log below and copy';
    }
};

dom.csv.onclick = async () => {
    if (!results.size) return;
    try {
        await navigator.clipboard.writeText(toCsv());
        dom.csv.textContent = 'CSV copied';
        setTimeout(() => { dom.csv.textContent = 'Copy CSV'; }, 2500);
    } catch {
        dom.log.textContent = toCsv();
    }
};
