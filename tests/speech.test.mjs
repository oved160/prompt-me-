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
    start() { this.startCalls += 1; this.onstart?.(); }
    abort() { this.onend?.(); }
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

test('an instantly-failing session backs off instead of spinning', async () => {
    const { listener, rec } = makeListener();
    listener.start();

    // Three instant end events in a row: the tight loop worth guarding against.
    rec().endSession();
    await sleep(20);
    rec().endSession();
    await sleep(20);
    rec().endSession();

    const callsRightAway = rec().startCalls;
    await sleep(120);
    // The backoff has grown past 120ms, so no restart has landed yet.
    assert.equal(rec().startCalls, callsRightAway, 'restarted too eagerly during a tight loop');

    // It still recovers rather than abandoning the user.
    await sleep(1200);
    assert.ok(rec().startCalls > callsRightAway, 'never came back after backing off');
    assert.ok(listener.running);
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
