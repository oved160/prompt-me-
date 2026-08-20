import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * A stand-in for the browser's MediaRecorder, so the timing arithmetic can be
 * checked without a camera. Only the surface Recorder actually touches.
 */
class FakeMediaRecorder {
    static supported = new Set();
    static isTypeSupported(type) { return FakeMediaRecorder.supported.has(type); }
    constructor(stream, options) {
        this.stream = stream;
        this.options = options;
        this.state = 'inactive';
    }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
}

globalThis.MediaRecorder = FakeMediaRecorder;
const { Recorder, pickMimeType } = await import('../js/recorder.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('pickMimeType prefers mp4, because galleries reject webm', () => {
    FakeMediaRecorder.supported = new Set(['video/webm;codecs=vp9,opus', 'video/mp4']);
    assert.equal(pickMimeType(), 'video/mp4');

    FakeMediaRecorder.supported = new Set(['video/webm;codecs=vp9,opus']);
    assert.equal(pickMimeType(), 'video/webm;codecs=vp9,opus');

    FakeMediaRecorder.supported = new Set();
    assert.equal(pickMimeType(), '');
});

test('recording is asked for at a bitrate that suits 1080p', () => {
    FakeMediaRecorder.supported = new Set(['video/mp4']);
    const r = new Recorder({});
    r.start();
    assert.equal(r.recorder.options.videoBitsPerSecond, 8_000_000);
});

test('state reports paused separately from inactive', () => {
    FakeMediaRecorder.supported = new Set(['video/mp4']);
    const r = new Recorder({});
    assert.equal(r.state, 'inactive');
    r.start();
    assert.equal(r.state, 'recording');
    r.pause();
    assert.equal(r.state, 'paused');
    r.resume();
    assert.equal(r.state, 'recording');
});

test('the clock does not run while the recording is paused', async () => {
    FakeMediaRecorder.supported = new Set(['video/mp4']);
    const r = new Recorder({});
    r.start();
    await sleep(120);
    r.pause();
    const atPause = r.elapsedMs;
    await sleep(160);
    // Held: the file gained nothing during those 160ms, so neither should the clock.
    assert.ok(Math.abs(r.elapsedMs - atPause) < 25,
        `clock ran while paused: ${atPause} -> ${r.elapsedMs}`);

    r.resume();
    await sleep(120);
    assert.ok(r.elapsedMs > atPause + 80, 'clock did not restart after resume');
    // Total stays well under the ~400ms of wall time that elapsed.
    assert.ok(r.elapsedMs < 330, `paused time leaked into the total: ${r.elapsedMs}`);
});

test('elapsed is zero before starting and after stopping', () => {
    FakeMediaRecorder.supported = new Set(['video/mp4']);
    const r = new Recorder({});
    assert.equal(r.elapsedMs, 0);
    r.start();
    r.stop();
    assert.equal(r.elapsedMs, 0);
});

test('starting with no supported type fails loudly', () => {
    FakeMediaRecorder.supported = new Set();
    const r = new Recorder({});
    assert.throws(() => r.start(), /mime type/i);
});

/* ---------------------------------------------- sharing and downloading */

const { takeFile, canShareVideo, shareRecording } = await import('../js/recorder.js');

function fakeBlob(type = 'video/mp4') {
    return { type, size: 1234 };
}

// navigator is a getter-only global in Node, so it has to be redefined rather
// than assigned. File is not defined there at all.
function stubEnv(nav) {
    globalThis.File = class { constructor(parts, name, opts) { this.name = name; this.type = opts.type; } };
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
}

test('the file is named and typed from the take', () => {
    stubEnv({});
    const f = takeFile(fakeBlob(), 'prompt-me-take-03');
    assert.equal(f.name, 'prompt-me-take-03.mp4');
    assert.equal(f.type, 'video/mp4');
});

test('a webm take gets the webm extension, since galleries reject it', () => {
    stubEnv({});
    assert.equal(takeFile(fakeBlob('video/webm;codecs=vp9,opus'), 'take').name, 'take.webm');
});

test('sharing is reported unsupported rather than attempted', async () => {
    stubEnv({}); // no canShare at all, as on desktop Firefox
    assert.equal(canShareVideo(fakeBlob(), 'take'), false);
    const result = await shareRecording(fakeBlob(), 'take');
    assert.equal(result.method, 'unsupported');
});

test('dismissing the share sheet is not treated as a failure', async () => {
    stubEnv({
        canShare: () => true,
        share: async () => { const e = new Error('dismissed'); e.name = 'AbortError'; throw e; },
    });
    const result = await shareRecording(fakeBlob(), 'take');
    assert.equal(result.method, 'cancelled', 'a dismissed sheet must leave the take recoverable');
});

test('a genuine share failure is distinguished from a dismissal', async () => {
    stubEnv({
        canShare: () => true,
        share: async () => { throw new Error('transport exploded'); },
    });
    assert.equal((await shareRecording(fakeBlob(), 'take')).method, 'failed');
});

test('a successful share reports success', async () => {
    let shared = null;
    stubEnv({ canShare: () => true, share: async (d) => { shared = d; } });
    assert.equal((await shareRecording(fakeBlob(), 'my-take')).method, 'share');
    assert.equal(shared.files.length, 1);
    assert.equal(shared.files[0].name, 'my-take.mp4');
});

test('canShareVideo survives a browser that throws from canShare', () => {
    stubEnv({ canShare: () => { throw new Error('nope'); } });
    assert.equal(canShareVideo(fakeBlob(), 'take'), false);
});
