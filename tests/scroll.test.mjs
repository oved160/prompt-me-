import test from 'node:test';
import assert from 'node:assert/strict';
import { stepScroll, FOCUS_RATIO, MAX_FRAME_SECONDS } from '../js/scroll.js';

test('constant mode advances at 40px per second at speed 1', () => {
    // One second of real 60fps frames, rather than one impossible 1s frame.
    let p = 0;
    for (let i = 0; i < 60; i++) p = stepScroll(p, { dt: 1 / 60, speed: 1 });
    assert.ok(Math.abs(p - 40) < 0.001, `expected ~40px, got ${p}`);
});

test('the speed multiplier scales the distance', () => {
    let slow = 0, fast = 0;
    for (let i = 0; i < 60; i++) {
        slow = stepScroll(slow, { dt: 1 / 60, speed: 1 });
        fast = stepScroll(fast, { dt: 1 / 60, speed: 3 });
    }
    assert.ok(Math.abs(fast - slow * 3) < 0.001, `expected 3x, got ${fast} vs ${slow}`);
});

test('pausing freezes the position', () => {
    assert.equal(stepScroll(250, { dt: 1, speed: 3, paused: true }), 250);
    assert.equal(stepScroll(250, { dt: 1, paused: true, voiceMode: true, wordTop: 9999 }), 250);
});

test('a long frame gap cannot launch the reader down the page', () => {
    // Simulates returning to a backgrounded tab after 30 seconds.
    const jumped = stepScroll(0, { dt: 30, speed: 1 });
    assert.equal(jumped, MAX_FRAME_SECONDS * 40);
    assert.ok(jumped < 5, `clamp failed, moved ${jumped}px in one frame`);
});

test('voice mode eases toward the current word, never snapping', () => {
    const viewportHeight = 800;
    const wordTop = 1000;
    const target = wordTop - viewportHeight * FOCUS_RATIO; // 664
    const next = stepScroll(0, { dt: 0.016, voiceMode: true, wordTop, viewportHeight });
    assert.ok(next > 0 && next < target, `expected partial move, got ${next}`);
    assert.equal(Math.round(next), Math.round(target * 0.08));
});

test('easing converges on the target without overshooting', () => {
    const viewportHeight = 800;
    const wordTop = 1000;
    const target = wordTop - viewportHeight * FOCUS_RATIO;
    let p = 0;
    for (let i = 0; i < 200; i++) {
        p = stepScroll(p, { dt: 0.016, voiceMode: true, wordTop, viewportHeight });
        assert.ok(p <= target + 0.001, `overshot the target at frame ${i}: ${p}`);
    }
    assert.ok(Math.abs(p - target) < 0.5, `did not converge, ended at ${p}`);
});

test('easing also walks backwards when the target is above', () => {
    const p = stepScroll(1000, { dt: 0.016, voiceMode: true, wordTop: 100, viewportHeight: 800 });
    assert.ok(p < 1000, 'should ease upward toward an earlier word');
});

test('voice mode with no current word falls back to constant scrolling', () => {
    // Happens once the reader passes the final word.
    const p = stepScroll(0, { dt: 1 / 60, speed: 1, voiceMode: true, wordTop: null });
    assert.ok(Math.abs(p - 40 / 60) < 0.001, `expected constant-speed step, got ${p}`);
});

test('scrolling stops at the end of the script', () => {
    // The constant-speed fallback would otherwise wind an empty screen upward
    // forever once the last word has gone by.
    let p = 0;
    for (let i = 0; i < 600; i++) p = stepScroll(p, { dt: 1 / 60, speed: 3, maxPosition: 100 });
    assert.equal(p, 100);
});

test('easing also respects the end of the script', () => {
    const p = stepScroll(95, { dt: 1 / 60, voiceMode: true, wordTop: 100000, viewportHeight: 800, maxPosition: 100 });
    assert.ok(p <= 100, `eased past the end to ${p}`);
});

test('a negative or zero delta never moves the position backwards', () => {
    assert.equal(stepScroll(50, { dt: 0, speed: 2 }), 50);
    assert.equal(stepScroll(50, { dt: -5, speed: 2 }), 50);
});
