/**
 * Turning a run's per-second samples into a verdict.
 *
 * Kept separate from bench.js and free of any DOM so it can be tested in Node.
 * This is the part where a quiet bug does the most damage: a judge that returns
 * PASS where it should return FAIL would send us on to build a feature the phone
 * cannot run, and nothing downstream would catch it.
 */

/** The encoder is still settling for the first few seconds; those are discarded. */
export const WARMUP_S = 5;
export const EARLY_WINDOW = [5, 25];
export const LATE_WINDOW = [70, 90];

/**
 * Fixed before any run, so no result can be read as whatever we hoped for.
 *
 * maxJitterMs was raised from 1500 to 4000 after the first real device run: a
 * phone's hardware H.264 encoder does not flush `ondataavailable` on the
 * 1-second timeslice `MediaRecorder.start(1000)` asks for — it batches into
 * bursts roughly every 3-3.5 seconds, and does this even at rest with zero
 * added load. 1500ms was failing every run on every device before any load was
 * added, which measures nothing. It has no effect on the final file: the app
 * concatenates whatever chunks arrive into one blob regardless of their
 * timing. 4000ms leaves headroom above the observed baseline cadence while
 * still catching a genuine stall.
 */
export const LIMITS = {
    minFps: 24,
    bitrateFloorRatio: 0.8,   // 20% below the no-load baseline
    maxJitterMs: 4000,
    maxDeclineRatio: 0.9,     // the late window may not sit 10% under the early one
};

export function median(xs) {
    if (!xs || !xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The real average bitrate over a window, from raw bytes and elapsed time.
 *
 * `windowOf`'s kbps is a median of the 5-sample smoothed per-second figure,
 * which is only honest when chunks land every second. This device's encoder
 * bursts every ~3.5s instead — a 3MB chunk on one second, zero on the next
 * two — and a 5-sample rolling window catches a different number of those
 * bursts depending on where the window boundary happens to fall. On the first
 * real device run that produced a fabricated 47% "decline" where the actual
 * figure, computed this way, was 14%. Summing bytes and time across the whole
 * window before dividing removes the phase sensitivity entirely: it does not
 * matter when within the window a burst landed, only how much data arrived in
 * total.
 */
export function windowRawKbps(run, [fromS, toS]) {
    const inWin = run.samples.filter((s) => s.t >= fromS && s.t < toS);
    if (!inWin.length) return null;
    const bytes = inWin.reduce((sum, s) => sum + s.bytes, 0);
    const secs = inWin.reduce((sum, s) => sum + s.dt, 0);
    return secs > 0 ? Math.round((bytes * 8) / 1000 / secs) : null;
}

export function windowOf(run, [fromS, toS]) {
    const inWin = run.samples.filter((s) => s.t >= fromS && s.t < toS);
    if (!inWin.length) return null;
    return {
        n: inWin.length,
        fps: median(inWin.map((s) => s.fps)),
        kbps: median(inWin.map((s) => s.kbps)),
        minFps: Math.min(...inWin.map((s) => s.fps)),
        maxJitter: Math.max(...inWin.map((s) => s.maxJitterMs)),
        maxLongTask: Math.max(...inWin.map((s) => s.longTaskMaxMs ?? 0)),
        maxDrift: Math.max(...inWin.map((s) => s.driftMaxMs ?? 0)),
        gflops: median(inWin.map((s) => s.loadGflops ?? 0)),
    };
}

/**
 * @param {object} run       a completed run
 * @param {object} [baseline] the 90s no-load run, if one exists yet
 * @returns {{fails: string[], notes: string[]}} everything wrong, and what could not be checked
 */
export function judge(run, baseline = null) {
    const post = run.samples.filter((s) => s.t >= WARMUP_S);
    const fails = [];
    const notes = [];
    const invalid = [];

    if (!post.length) {
        return { invalid, fails: ['run produced no samples after warm-up'], notes };
    }

    // A backgrounded page has requestAnimationFrame throttled to roughly half a
    // frame per second, so the compositor stops, the canvas stops producing
    // frames, and the encoder receives almost nothing. Every threshold below
    // then fails spectacularly — and none of it says anything about whether the
    // phone has compute headroom, which is the only question being asked.
    //
    // On a phone this is not hypothetical: the screen dimming, a notification
    // taking focus, or the reader glancing at another app all do it. Such a run
    // is void, not failed. Reporting it as FAIL would have us abandon a phone
    // that was never actually tested.
    const hiddenSamples = run.samples.filter((s) => s.hidden).length;
    if (hiddenSamples > 0) {
        invalid.push(`the page was backgrounded for ${hiddenSamples}s of this run — ` +
                     'rAF was throttled, so these numbers measure nothing. Re-run with the ' +
                     'screen on and this tab in front.');
        return { invalid, fails, notes };
    }

    const minFps = Math.min(...post.map((s) => s.fps));
    if (minFps < LIMITS.minFps) {
        fails.push(`composite fps fell to ${minFps.toFixed(1)} (floor ${LIMITS.minFps})`);
    }

    const maxJitter = Math.max(...post.map((s) => s.maxJitterMs));
    if (maxJitter > LIMITS.maxJitterMs) {
        fails.push(`chunk jitter reached ${maxJitter}ms (limit ${LIMITS.maxJitterMs})`);
    }

    if (run.mrErrors && run.mrErrors.length) {
        fails.push(`MediaRecorder errors: ${run.mrErrors.join(', ')}`);
    }

    // Raw totals, not a median of already-smoothed samples: see windowRawKbps.
    const lastT = post.length ? post[post.length - 1].t + 1 : Infinity;
    const kbps = windowRawKbps(run, [WARMUP_S, lastT]) ?? 0;
    if (baseline && baseline !== run) {
        const baselinePost = baseline.samples.filter((s) => s.t >= WARMUP_S);
        const baselineLastT = baselinePost.length ? baselinePost[baselinePost.length - 1].t + 1 : Infinity;
        const ref = windowRawKbps(baseline, [WARMUP_S, baselineLastT]) ?? 0;
        if (ref > 0 && kbps < ref * LIMITS.bitrateFloorRatio) {
            fails.push(`bitrate ${kbps}kbps is ${Math.round(100 - (kbps / ref) * 100)}% below the ${ref}kbps baseline`);
        }
    } else if (!baseline) {
        notes.push('no 90s baseline recorded yet, so the bitrate threshold was not applied');
    }

    // Sustained degradation. An addition to the five agreed thresholds, and the
    // entire reason for sampling a series: a phone shedding 10% in ninety
    // seconds has not finished shedding, and a three minute take crosses the
    // floor. Deliberately fires even when both windows sit above the floor.
    const early = windowOf(run, EARLY_WINDOW);
    const late = windowOf(run, LATE_WINDOW);
    if (early) early.kbps = windowRawKbps(run, EARLY_WINDOW) ?? early.kbps;
    if (late) late.kbps = windowRawKbps(run, LATE_WINDOW) ?? late.kbps;
    if (early && late) {
        if (late.fps < early.fps * LIMITS.maxDeclineRatio) {
            fails.push(`fps declined ${Math.round(100 - (late.fps / early.fps) * 100)}% ` +
                       `(${early.fps.toFixed(1)} → ${late.fps.toFixed(1)}) — throttling`);
        }
        if (early.kbps > 0 && late.kbps < early.kbps * LIMITS.maxDeclineRatio) {
            fails.push(`bitrate declined ${Math.round(100 - (late.kbps / early.kbps) * 100)}% ` +
                       `(${early.kbps} → ${late.kbps} kbps) — throttling`);
        }
    } else if (run.seconds >= 90) {
        notes.push('early or late window incomplete, degradation not assessed');
    } else {
        notes.push(`run was ${run.seconds}s, too short to assess degradation`);
    }

    return { invalid, fails, notes, early, late, kbps, minFps, maxJitter };
}

/**
 * Rolling five second bitrate, written back onto each sample.
 *
 * Per-second byte counts are chunky because chunks do not land on the sample
 * boundaries, and a median over that is noise. Smoothing makes the curve
 * readable without inventing anything that was not measured.
 */
export function deriveBitrate(samples) {
    for (let i = 0; i < samples.length; i++) {
        const window = samples.slice(Math.max(0, i - 4), i + 1);
        const bytes = window.reduce((sum, s) => sum + s.bytes, 0);
        const secs = window.reduce((sum, s) => sum + s.dt, 0);
        samples[i].kbps = Math.round((bytes * 8) / 1000 / (secs || 1));
    }
    return samples;
}
