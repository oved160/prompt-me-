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
