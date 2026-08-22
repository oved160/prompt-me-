import test from 'node:test';
import assert from 'node:assert/strict';
import {
    judge, windowOf, median, deriveBitrate, LIMITS, WARMUP_S,
} from '../bench-analysis.js';

/**
 * Builds a run of per-second samples.
 *
 * `shape` receives the second and returns overrides, so a test can describe a
 * phone that decays, stalls, or holds steady without spelling out ninety rows.
 */
function makeRun(seconds, shape = () => ({}), extra = {}) {
    const samples = [];
    for (let t = 0; t < seconds; t++) {
        samples.push({
            t, dt: 1, fps: 30, bytes: 1_000_000, kbps: 8000, maxJitterMs: 1000,
            longTaskMaxMs: 0, driftMaxMs: 0, loadGflops: 0,
            ...shape(t),
        });
    }
    return { id: 'r', label: 'r', seconds, duty: 0, where: 'none', samples, mrErrors: [], ...extra };
}

const healthy = () => makeRun(90);

test('a clean run passes', () => {
    const { fails } = judge(healthy(), healthy());
    assert.deepEqual(fails, [], `clean run was failed: ${fails}`);
});

test('fps below the floor fails', () => {
    const run = makeRun(90, (t) => (t === 50 ? { fps: 21 } : {}));
    const { fails } = judge(run, healthy());
    assert.ok(fails.some((f) => f.includes('fps fell to 21')), `not caught: ${fails}`);
});

test('a dip inside the warm-up window is forgiven', () => {
    // The encoder is still settling; failing on it would fail every run.
    const run = makeRun(90, (t) => (t < WARMUP_S ? { fps: 5 } : {}));
    const { fails } = judge(run, healthy());
    assert.deepEqual(fails, [], `warm-up dip was treated as a failure: ${fails}`);
});

test('chunk jitter over the limit fails', () => {
    // The limit sits above this device's own normal batching cadence (see
    // LIMITS.maxJitterMs) — this value only exceeds it, it does not describe
    // ordinary behaviour.
    const run = makeRun(90, (t) => (t === 40 ? { maxJitterMs: 4400 } : {}));
    const { fails } = judge(run, healthy());
    assert.ok(fails.some((f) => f.includes('jitter reached 4400')), `not caught: ${fails}`);
});

test('the jitter this device normally batches at is not itself a failure', () => {
    // The bug that prompted raising the limit: a real device recorded 3400ms
    // gaps at rest, with zero load, because its hardware encoder bursts every
    // ~3.5s rather than flushing every 1s the way MediaRecorder was asked to.
    // That is not the phone failing.
    const run = makeRun(90, () => ({ maxJitterMs: 3400 }));
    const { fails } = judge(run, healthy());
    assert.ok(!fails.some((f) => f.includes('jitter')),
        `normal batching cadence for this device was reported as a failure: ${fails}`);
});

test('a MediaRecorder error fails regardless of the numbers', () => {
    const run = makeRun(90, () => ({}), { mrErrors: ['UnknownError'] });
    const { fails } = judge(run, healthy());
    assert.ok(fails.some((f) => f.includes('UnknownError')), `not caught: ${fails}`);
});

test('bitrate more than 20% under baseline fails', () => {
    // bytes drives the real check now (see windowRawKbps); kbps is kept on the
    // fixture only for a human reading the test to see the intended rate.
    const run = makeRun(90, () => ({ bytes: 750_000, kbps: 6000 })); // 25% down on 8000
    const { fails } = judge(run, healthy());
    assert.ok(fails.some((f) => f.includes('below the 8000kbps baseline')), `not caught: ${fails}`);
});

test('bitrate just inside the 20% margin passes', () => {
    const run = makeRun(90, () => ({ bytes: 812_500, kbps: 6500 })); // 18.75% down
    const { fails } = judge(run, healthy());
    assert.deepEqual(fails, [], `a run inside the margin was failed: ${fails}`);
});

test('a bursty but stable chunk cadence is not read as a bitrate decline', () => {
    // The real bug, caught on the first device run: this phone's encoder does
    // not deliver a chunk every second. It bursts every ~3.5s at a genuinely
    // steady rate. The old check compared a median of an already-smoothed
    // per-second figure, and depending on where the 5-sample window landed
    // relative to the bursts, that fabricated a "47% decline" that a hand
    // calculation of the same raw numbers showed was actually 14%. Summing
    // bytes and time across the whole window before dividing must be immune to
    // exactly this: it should not matter when within the window a burst
    // happened to land.
    const BURST_BYTES = 3_000_000; // 3s of an 8Mbps stream, delivered on the 3rd second
    const run = makeRun(90, (t) => ({
        bytes: (t + 1) % 3 === 0 ? BURST_BYTES : 0,
        kbps: 0, // deliberately wrong/unused, to prove the fix ignores this field
    }));
    const { fails, early, late } = judge(run, run); // its own cadence is the baseline here
    assert.ok(!fails.some((f) => f.includes('throttling')),
        `a steady bursty cadence was read as throttling: ${fails}`);
    // Both windows should land close to the real long-run average, ~8000kbps,
    // regardless of which second inside each window the last burst fell on.
    assert.ok(Math.abs(early.kbps - 8000) < 1500, `early window drifted: ${early.kbps}`);
    assert.ok(Math.abs(late.kbps - 8000) < 1500, `late window drifted: ${late.kbps}`);
});

test('thermal decline is caught even while everything stays above the floor', () => {
    // The whole reason for sampling a series rather than an average. Both
    // windows sit comfortably over 24fps, and the average across the run looks
    // fine, but the phone is visibly shedding performance and a longer take
    // would cross the floor.
    const run = makeRun(90, (t) => ({ fps: t < 40 ? 30 : 26 }));
    const { fails } = judge(run, healthy());
    assert.ok(fails.some((f) => f.includes('throttling')),
        `a phone losing 13% of its framerate was passed: ${fails}`);
    assert.ok(Math.min(...run.samples.map((s) => s.fps)) > LIMITS.minFps,
        'the fixture must stay above the floor or it proves nothing');
});

test('a small wobble is not called throttling', () => {
    // 30 → 28 is under 10%; flagging it would make the check useless noise.
    const run = makeRun(90, (t) => ({ fps: t < 40 ? 30 : 28 }));
    const { fails } = judge(run, healthy());
    assert.deepEqual(fails, [], `normal variance was reported as throttling: ${fails}`);
});

test('bitrate decline is informational, never a hard failure', () => {
    // The third real device finding: two zero-load baselines, same phone, same
    // test, back to back sessions — one declined 14% early to late, the other
    // declined 0.3%. The only thing that changed was whatever was in front of
    // the camera. A bitrate check built on that number cannot tell "the phone
    // is struggling" from "the reader held still for a while", so it must never
    // fail on its own — however large the swing.
    const baseline = makeRun(90, (t) => ({ bytes: t < 40 ? 1_100_000 : 1_098_000 })); // ~0.2%
    const run = makeRun(90, (t) => ({ bytes: t < 40 ? 1_100_000 : 400_000 })); // ~64% down
    const { fails, notes } = judge(run, baseline);
    assert.ok(!fails.some((f) => f.includes('throttling')),
        `bitrate swing was treated as a hard failure: ${fails}`);
    assert.ok(notes.some((n) => n.includes('bitrate moved')), `no note recording the swing: ${notes}`);
});

test('an fps decline meaningfully worse than the baseline still fails', () => {
    // fps has not shown the session-to-session swings bitrate has, so it stays
    // a real gate: a phone that is actually falling behind shows up here.
    const baseline = makeRun(90, (t) => ({ fps: t < 40 ? 30 : 29 })); // ~3% down at rest
    const run = makeRun(90, (t) => ({ fps: t < 40 ? 30 : 20 })); // ~33% down under load
    const { fails } = judge(run, baseline);
    assert.ok(fails.some((f) => f.includes('fps declined') && f.includes('throttling')),
        `an fps decline far beyond the baseline's own was not caught: ${fails}`);
});

test('a short run says degradation was not assessed rather than passing it silently', () => {
    const run = makeRun(20);
    const { fails, notes } = judge(run, healthy());
    assert.deepEqual(fails, []);
    assert.ok(notes.some((n) => n.includes('too short')), `no note explaining the gap: ${notes}`);
});

test('with no baseline yet, the bitrate threshold is skipped and said to be skipped', () => {
    const run = makeRun(90, () => ({ kbps: 100 })); // catastrophic, but nothing to compare to
    const { fails, notes } = judge(run, null);
    assert.ok(!fails.some((f) => f.includes('baseline')), 'compared against a baseline it does not have');
    assert.ok(notes.some((n) => n.includes('no 90s baseline')), `silently skipped: ${notes}`);
});

test('the baseline is not judged against itself', () => {
    const base = healthy();
    const { fails } = judge(base, base);
    assert.deepEqual(fails, [], `the baseline failed its own comparison: ${fails}`);
});

test('a baseline with a genuine decline does not fail on its own first reading', () => {
    // The exact bug the previous test's flat fixture hid: at the moment E2 is
    // first recorded it IS the stored baseline, so `results.get('baseline90')`
    // returns the very same object being judged. Comparing its real 14% dip
    // against a decline of 0% would fail the baseline before anything exists
    // to compare it to — which is what actually happened until this was caught.
    const run = makeRun(90, (t) => ({ bytes: t < 40 ? 1_100_000 : 950_000 })); // ~14% down
    const { fails, notes } = judge(run, run);
    assert.deepEqual(fails, [], `a baseline was blamed for its own first-ever reading: ${fails}`);
    assert.ok(notes.some((n) => n.includes('no independent baseline')), `no note explaining why: ${notes}`);
});

test('a backgrounded run is void, not failed', () => {
    // Found by running the harness in a pane that reported visibilityState
    // hidden: rAF throttles to about half a frame per second, the compositor
    // stops, and the encoder gets nothing. Every threshold fails at once, and
    // none of it says anything about compute headroom. Calling that FAIL would
    // have us write off a phone that was never actually tested.
    const run = makeRun(90, (t) => (t > 30 ? { fps: 0.5, kbps: 0, maxJitterMs: 40000, hidden: true } : {}));
    const { invalid, fails } = judge(run, healthy());
    assert.ok(invalid.length, 'a run with a backgrounded page was not marked invalid');
    assert.deepEqual(fails, [], 'a void run must not also report threshold failures');
    assert.ok(invalid[0].includes('backgrounded'), invalid[0]);
});

test('a run that stayed visible is judged normally', () => {
    const run = makeRun(90, () => ({ hidden: false }));
    const { invalid, fails } = judge(run, healthy());
    assert.deepEqual(invalid, []);
    assert.deepEqual(fails, []);
});

test('one backgrounded second is enough to void the run', () => {
    // Partial data is worse than none: it looks plausible and is not.
    const run = makeRun(90, (t) => (t === 44 ? { hidden: true } : {}));
    const { invalid } = judge(run, healthy());
    assert.ok(invalid.length, 'a single hidden sample was averaged away');
});

test('an empty run is reported, not passed', () => {
    const { fails } = judge({ seconds: 90, samples: [], mrErrors: [] }, healthy());
    assert.ok(fails.length, 'a run with no samples was treated as a pass');
});

test('windowOf ignores samples outside its bounds', () => {
    const run = makeRun(90, (t) => ({ fps: t < 25 ? 30 : 10 }));
    assert.equal(windowOf(run, [5, 25]).fps, 30);
    assert.equal(windowOf(run, [70, 90]).fps, 10);
    assert.equal(windowOf(run, [200, 300]), null);
});

test('median handles even, odd and empty', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), 0);
});

test('bitrate is derived from real elapsed time, not the nominal second', () => {
    // Under heavy load the sampler drifts. Dividing by 1000 anyway would
    // understate every rate at exactly the moment the number matters most.
    const samples = [{ bytes: 2_000_000, dt: 2 }];
    deriveBitrate(samples);
    assert.equal(samples[0].kbps, 8000, 'a two second gap was billed as one second');
});

test('bitrate smooths over five seconds without inventing data', () => {
    // Chunks do not land on sample boundaries: one second gets two, the next
    // none. The smoothed series must not read that as a stall.
    const samples = [
        { bytes: 1_000_000, dt: 1 }, { bytes: 0, dt: 1 }, { bytes: 2_000_000, dt: 1 },
        { bytes: 0, dt: 1 }, { bytes: 1_000_000, dt: 1 },
    ];
    deriveBitrate(samples);
    assert.equal(samples[4].kbps, 6400, 'the trailing window did not average the gaps out');
    assert.ok(samples[4].kbps > 0);
});
