import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechActivity, rmsOf } from '../js/voicelevel.js';

/** Feeds a level for a stretch of time, 20ms per frame, and reports the result. */
function feed(detector, rms, ms, startAt = 0) {
    let t = startAt;
    let speaking = detector.speaking;
    for (; t < startAt + ms; t += 20) speaking = detector.update(rms, t);
    return { speaking, endedAt: t };
}

test('rmsOf measures loudness, and silence is zero', () => {
    assert.equal(rmsOf(new Float32Array([0, 0, 0, 0])), 0);
    assert.equal(rmsOf(new Float32Array([1, -1, 1, -1])), 1);
    assert.ok(rmsOf(new Float32Array([0.5, -0.5])) > rmsOf(new Float32Array([0.1, -0.1])));
    assert.equal(rmsOf(new Float32Array()), 0);
    assert.equal(rmsOf(null), 0);
});

test('a quiet room is not mistaken for speech', () => {
    const d = new SpeechActivity();
    const { speaking } = feed(d, 0.002, 2000);
    assert.equal(speaking, false);
});

test('speaking over a quiet room is detected', () => {
    const d = new SpeechActivity();
    let at = feed(d, 0.002, 1000).endedAt;      // settle on the room
    const { speaking } = feed(d, 0.08, 200, at); // then talk
    assert.equal(speaking, true);
});

test('it keeps going through the gaps between words', () => {
    const d = new SpeechActivity();
    let at = feed(d, 0.002, 1000).endedAt;
    at = feed(d, 0.08, 200, at).endedAt;
    // A short pause mid-sentence must not stop the script dead.
    const { speaking } = feed(d, 0.002, 200, at);
    assert.equal(speaking, true, 'stopped during a normal pause between words');
});

test('it stops once the reader genuinely stops', () => {
    const d = new SpeechActivity();
    let at = feed(d, 0.002, 1000).endedAt;
    at = feed(d, 0.08, 300, at).endedAt;
    const { speaking } = feed(d, 0.002, 900, at); // well past the hold
    assert.equal(speaking, false);
});

test('a noisy room raises the bar rather than scrolling forever', () => {
    // Constant loud hum, no speech: the floor climbs to meet it and the script
    // must not be dragged along by the noise.
    const d = new SpeechActivity();
    const { speaking } = feed(d, 0.05, 6000);
    assert.equal(speaking, false, 'steady background noise was treated as speech');
});

test('speech still registers over a noisy room', () => {
    const d = new SpeechActivity();
    let at = feed(d, 0.05, 6000).endedAt;        // settle on a loud room
    const { speaking } = feed(d, 0.4, 200, at);  // talk over it
    assert.equal(speaking, true);
});

test('a sudden bang does not lock the reader out afterwards', () => {
    const d = new SpeechActivity();
    let at = feed(d, 0.002, 1000).endedAt;
    at = feed(d, 0.9, 100, at).endedAt;          // a door slams
    at = feed(d, 0.002, 1000, at).endedAt;       // quiet again
    const { speaking } = feed(d, 0.08, 200, at); // normal speech
    assert.equal(speaking, true, 'the floor rose on one loud noise and never came back down');
});

test('reset returns it to a clean slate', () => {
    const d = new SpeechActivity();
    feed(d, 0.08, 500);
    d.reset();
    assert.equal(d.speaking, false);
    assert.equal(d.started, false);
});
