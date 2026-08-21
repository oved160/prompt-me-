import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Stands in for the browser's SpeechRecognition. The behaviour that matters is
 * the one that broke on Android: `end` firing over and over, which is normal
 * there rather than a fault.
 */
class FakeRecognition {
    constructor() {
        FakeRecognition.instances.push(this);
        this.startCalls = 0;
    }
    start(audioTrack) {
        this.startedWith = audioTrack;
        this.startCalls += 1;
        this.onstart?.();
        this.aborted = false;
        // A device stuck in a tight loop ends the session the instant it opens.
        if (this.dieInstantly) setTimeout(() => this.onend?.(), 0);
    }
    abort() {
        // The Android failure mode this guards against: abort() on a wedged
        // session does not necessarily produce an onend either.
        this.aborted = true;
        if (!this.swallowAbort) this.onend?.();
    }
    /** Simulate Chrome ending the session on its own. */
    endSession() { this.onend?.(); }
}
FakeRecognition.instances = [];

globalThis.window = { SpeechRecognition: FakeRecognition };
const { SpeechListener } = await import('../js/speech.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeListener(opts = {}) {
    FakeRecognition.instances = [];
    const events = [];
    const listener = new SpeechListener({
        onStatus: (s) => events.push(s),
        onError: (e) => events.push(`ERROR:${e}`),
        ...opts,
    });
    return { listener, events, rec: () => FakeRecognition.instances[0] };
}

test('a phone ending the session repeatedly never disables voice tracking', async () => {
    // The regression this exists for. Android fires `end` constantly; the old
    // guard gave up permanently after five of them inside ten seconds, so voice
    // tracking switched itself off within seconds of starting.
    const { listener, events, rec } = makeListener();
    listener.start();

    for (let i = 0; i < 8; i++) {
        rec().endSession();
        await sleep(60);
    }

    assert.ok(listener.running, 'listener gave up on its own');
    assert.ok(!events.some(e => e.startsWith('ERROR:')),
        `reported a failure for normal cycling: ${events.filter(e => e.startsWith('ERROR:'))}`);
});

test('a session that ran a healthy length restarts immediately', async () => {
    const { listener, rec } = makeListener();
    listener.start();
    const before = rec().startCalls;

    // Pretend the session had been running comfortably before it ended.
    listener._sessionStart = Date.now() - 5000;
    rec().endSession();

    await sleep(400);
    assert.equal(rec().startCalls, before + 1, 'did not restart promptly after a healthy session');
});

test('a session that dies the instant it opens is throttled, not spun', async () => {
    // The real fault worth guarding against: recognition that fails to open at
    // all, over and over. Left ungoverned it would restart flat out and pin the
    // CPU. The fake drives the loop itself here rather than the test stacking
    // timers, which is what actually happens on a broken device.
    const { listener, rec } = makeListener();
    listener.start();
    rec().dieInstantly = true;
    rec().endSession(); // the first session has already opened, so end it to begin the loop

    await sleep(1000);
    const inFirstSecond = rec().startCalls;
    assert.ok(inFirstSecond < 12,
        `restarted ${inFirstSecond} times in a second, which is spinning rather than backing off`);

    // And it must not give up: it is still trying, just slowly. The wait has to
    // clear the four second ceiling the backoff has reached by now.
    const before = rec().startCalls;
    await sleep(4500);
    assert.ok(rec().startCalls > before, 'stopped trying altogether');
    assert.ok(listener.running);
    // Without this the restart chain keeps rescheduling itself forever and the
    // test process never exits.
    listener.stop();
    rec().dieInstantly = false;
});

test('stop() is honoured and does not trigger a restart', async () => {
    const { listener, rec } = makeListener();
    listener.start();
    const calls = rec().startCalls;
    listener.stop();
    await sleep(600);
    assert.equal(rec().startCalls, calls, 'restarted after the user switched it off');
    assert.ok(!listener.running);
});

test('a denied microphone stops rather than looping forever', async () => {
    const { listener, events, rec } = makeListener();
    listener.start();
    rec().onerror({ error: 'not-allowed' });
    assert.ok(!listener.running, 'kept trying after permission was refused');
    assert.ok(events.some(e => e.startsWith('ERROR:')), 'permission denial was not reported');
});

test('no-speech is passed through as a status, not a fatal error', async () => {
    const { listener, events, rec } = makeListener();
    listener.start();
    rec().onerror({ error: 'no-speech' });
    assert.ok(listener.running, 'a silent moment should not end voice tracking');
    assert.ok(events.some(e => e.includes('no-speech')), 'the code was swallowed');
});

test('normal Android sessions do not trigger the tight-loop backoff', async () => {
    // Chrome on Android ignores `continuous` and ends a session after each
    // utterance, typically after one to two seconds. Treating that as a fault
    // and backing off left the recogniser switched off for seconds at a time,
    // which is indistinguishable from voice tracking simply not working.
    const { listener, rec } = makeListener();
    listener.start();

    for (let i = 0; i < 6; i++) {
        // A session that ran for a second and a half, then ended by itself.
        listener._sessionStart = Date.now() - 1500;
        const before = rec().startCalls;
        rec().endSession();
        await sleep(200);
        assert.equal(rec().startCalls, before + 1,
            `utterance ${i + 1}: recogniser had not restarted within 200ms`);
    }
    assert.ok(listener.running);
});

test('the backoff keeps growing while the failure persists', async () => {
    const { listener, rec } = makeListener();
    listener.start();
    rec().dieInstantly = true;
    rec().endSession();

    await sleep(600);
    const early = rec().startCalls;
    await sleep(600);
    const laterGrowth = rec().startCalls - early;

    // Restarts thin out as the delay doubles, rather than continuing at a
    // constant rate.
    assert.ok(laterGrowth <= early,
        `restarts did not thin out: ${early} in the first 600ms, ${laterGrowth} in the next`);
    listener.stop();
    rec().dieInstantly = false;
});

test('a recogniser stuck repeating one interim result is torn down and restarted', async () => {
    // Taken from a real Android log: the same interim hypothesis arrived 34
    // times across 5.7 seconds while the reader kept talking, and `onend` never
    // fired, so the normal restart path never ran. It looked alive from the
    // outside while it had stopped listening.
    const { listener, rec, events } = makeListener();
    listener.start();
    const startsBefore = rec().startCalls;

    const stuck = 'היי קוראים לי עובד אלישע וזה הסבר קצר על';
    for (let i = 0; i < 10; i++) {
        rec().onresult({
            resultIndex: 0,
            results: [Object.assign([{ transcript: stuck }], { isFinal: false })],
        });
        await sleep(150);
    }

    // No onend was ever fired, exactly as on the device.
    await sleep(3200);
    assert.ok(rec().startCalls > startsBefore,
        'never recovered: it was still waiting for an onend that does not come');
    assert.ok(events.some(e => String(e).includes('stuck')) ||
              rec().startCalls > startsBefore, 'no restart was forced');
    listener.stop();
});

test('a recogniser making real progress is left alone', async () => {
    // The watchdog must not interrupt a session that is genuinely transcribing.
    const { listener, rec } = makeListener();
    listener.start();
    const startsBefore = rec().startCalls;

    for (let i = 0; i < 12; i++) {
        rec().onresult({
            resultIndex: 0,
            results: [Object.assign([{ transcript: `word ${i}` }], { isFinal: false })],
        });
        await sleep(300);
    }

    assert.equal(rec().startCalls, startsBefore,
        'restarted a session that was transcribing perfectly well');
    listener.stop();
});

test('an existing audio track is handed to the recogniser', async () => {
    // Android refuses a second microphone while a recording holds one, so
    // sharing the track we already own is the only way word tracking can run
    // during a take.
    FakeRecognition.instances = [];
    const track = { kind: 'audio', readyState: 'live' };
    const listener = new SpeechListener({ audioTrack: track });
    listener.start();
    assert.equal(FakeRecognition.instances[0].startedWith, track,
        'the recogniser opened its own microphone instead of using the track');
    listener.stop();
});

test('a dead track is not passed, since that throws and kills recognition', async () => {
    // The spec throws InvalidStateError unless the track is live.
    FakeRecognition.instances = [];
    const listener = new SpeechListener({ audioTrack: { kind: 'audio', readyState: 'ended' } });
    listener.start();
    assert.equal(FakeRecognition.instances[0].startedWith, undefined,
        'passed a track that would have thrown');
    assert.ok(listener.running, 'recognition should still have started normally');
    listener.stop();
});

test('with no track supplied it opens the microphone as before', async () => {
    FakeRecognition.instances = [];
    const listener = new SpeechListener({});
    listener.start();
    assert.equal(FakeRecognition.instances[0].startedWith, undefined);
    listener.stop();
});
