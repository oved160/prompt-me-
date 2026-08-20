import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechActivity, rmsOf } from '../js/voicelevel.js';

/**
 * Feeds a level for a stretch of time at roughly 60fps, the rate the scroll
 * loop actually samples at.
 *
 * These tests used to begin every scenario with a second of quiet room, to let
 * the detector "settle". That was an assumption about usage, not a fact about
 * it: the countdown clears and the reader starts talking immediately, so the
 * first sample the detector ever sees is speech. Encoding the settling period
 * hid a bug that made the feature useless in practice. Scenarios below start
 * the way real takes start.
 */
function feed(detector, rms, ms, startAt = 0) {
    let t = startAt;
    let speaking = detector.speaking;
    for (; t < startAt + ms; t += 16) speaking = detector.update(rms, t);
    return { speaking, endedAt: t };
}

const SPEECH = 0.09;
const ROOM = 0.002;

test('rmsOf measures loudness, and silence is zero', () => {
    assert.equal(rmsOf(new Float32Array([0, 0, 0, 0])), 0);
    assert.equal(rmsOf(new Float32Array([1, -1, 1, -1])), 1);
    assert.ok(rmsOf(new Float32Array([0.5, -0.5])) > rmsOf(new Float32Array([0.1, -0.1])));
    assert.equal(rmsOf(new Float32Array()), 0);
    assert.equal(rmsOf(null), 0);
});

test('talking from the very first frame is detected', () => {
    // The exact failure reported: the reader speaks the instant recording
    // starts, and the script sat still for the whole take.
    const d = new SpeechActivity();
    const { speaking } = feed(d, SPEECH, 200);
    assert.equal(speaking, true, 'speech from the first sample must register');
});

test('unbroken speech keeps being detected, not just the first second', () => {
    // A floor that learns from speech creeps up until it exceeds the voice that
    // raised it, and the script stops mid-take.
    const d = new SpeechActivity();
    const { speaking } = feed(d, SPEECH, 10000);
    assert.equal(speaking, true, 'stopped detecting a voice that never stopped');
    assert.ok(d.floor <= d.opts.floorCeiling);
});

test('a quiet room is not mistaken for speech', () => {
    const d = new SpeechActivity();
    const { speaking } = feed(d, ROOM, 3000);
    assert.equal(speaking, false);
});

test('it keeps going through the gaps between words', () => {
    const d = new SpeechActivity();
    let at = feed(d, SPEECH, 600).endedAt;
    const { speaking } = feed(d, ROOM, 200, at);
    assert.equal(speaking, true, 'stopped during a normal pause between words');
});

test('it stops once the reader genuinely stops', () => {
    const d = new SpeechActivity();
    let at = feed(d, SPEECH, 600).endedAt;
    const { speaking } = feed(d, ROOM, 900, at);
    assert.equal(speaking, false);
});

test('speech still registers over a noisy room', () => {
    const d = new SpeechActivity();
    let at = feed(d, 0.03, 4000).endedAt;
    const { speaking } = feed(d, 0.4, 200, at);
    assert.equal(speaking, true);
});

test('a very loud room lets everything through rather than freezing', () => {
    // Deliberate: past the floor ceiling the gate cannot tell voice from room,
    // and a script that over-scrolls beats one that never moves. This is a
    // trade chosen on purpose, not an accident.
    const d = new SpeechActivity();
    const { speaking } = feed(d, 0.05, 5000);
    assert.equal(speaking, true);
});

test('a sudden bang does not lock the reader out afterwards', () => {
    const d = new SpeechActivity();
    let at = feed(d, ROOM, 1000).endedAt;
    at = feed(d, 0.9, 100, at).endedAt;
    at = feed(d, ROOM, 1500, at).endedAt;
    const { speaking } = feed(d, SPEECH, 200, at);
    assert.equal(speaking, true, 'the floor rose on one loud noise and never came back down');
});

test('an analyser producing digital silence is reported as broken', () => {
    // A suspended AudioContext returns pure zeros forever. Left gating the
    // scroll, it would hold the script still for the entire take.
    const d = new SpeechActivity();
    let t = 0;
    for (; t < 3000; t += 16) d.update(0, t);
    assert.equal(d.isDeaf(t), true);
    assert.equal(d.speaking, false, 'silence is still silence');
});

test('a working but quiet microphone is not called broken', () => {
    const d = new SpeechActivity();
    let t = 0;
    for (; t < 3000; t += 16) d.update(0.008, t);
    assert.equal(d.isDeaf(t), false, 'real room tone means the analyser is alive');
});

test('deafness is not declared before there is evidence for it', () => {
    const d = new SpeechActivity();
    d.update(0, 0);
    assert.equal(d.isDeaf(100), false, 'too early to conclude anything');
});

test('reset returns it to a clean slate', () => {
    const d = new SpeechActivity();
    feed(d, SPEECH, 500);
    d.reset();
    assert.equal(d.speaking, false);
    assert.equal(d.startedAt, -1);
});
