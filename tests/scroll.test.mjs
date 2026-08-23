import test from 'node:test';
import assert from 'node:assert/strict';
import { stepScroll, naturalPace, nearestWordIndex, scrollProgress, FOCUS_RATIO, MAX_FRAME_SECONDS, PIXELS_PER_SPEED_UNIT } from '../js/scroll.js';

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
    const target = wordTop - viewportHeight * FOCUS_RATIO;
    const next = stepScroll(0, { dt: 1 / 60, voiceMode: true, wordTop, viewportHeight });
    assert.ok(next > 0, 'should move toward the word');
    assert.ok(next < target, `should not snap straight to it, got ${next} of ${target}`);
});

test('the same second of easing covers the same ground at any framerate', () => {
    // A fraction-per-frame ease made a 120Hz phone pace twice as fast as a
    // 60Hz one. One second of catching up must be one second either way.
    const opts = { voiceMode: true, wordTop: 1000, viewportHeight: 800 };
    const run = (fps) => {
        let p = 0;
        for (let i = 0; i < fps; i++) p = stepScroll(p, { ...opts, dt: 1 / fps });
        return p;
    };
    const at60 = run(60);
    const at120 = run(120);
    const at30 = run(30);
    assert.ok(Math.abs(at60 - at120) < 1, `60Hz ${at60} vs 120Hz ${at120}`);
    assert.ok(Math.abs(at60 - at30) < 1, `60Hz ${at60} vs 30Hz ${at30}`);
});

test('it catches up with a reader within a sensible time', () => {
    // Falling a screen behind and taking many seconds to recover is what makes
    // a prompter feel like it is lagging.
    const target = 1000 - 800 * FOCUS_RATIO;
    let p = 0;
    for (let i = 0; i < 30; i++) p = stepScroll(p, { dt: 1 / 60, voiceMode: true, wordTop: 1000, viewportHeight: 800 });
    assert.ok(p > target * 0.9, `only covered ${Math.round((p / target) * 100)}% of the gap in half a second`);
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

test('the natural pace comes from the script, not a fixed guess', () => {
    // 140 words at 140wpm is one minute; 6000px of script over 60s is 100px/s.
    assert.equal(naturalPace(6000, 140), 100);
    // A longer script over the same height reads faster per word, so scrolls slower.
    assert.ok(naturalPace(6000, 280) < naturalPace(6000, 140) * 1.01);
    assert.ok(naturalPace(6000, 280) > 0);
});

test('the natural pace falls back rather than dividing by nothing', () => {
    assert.equal(naturalPace(0, 140), PIXELS_PER_SPEED_UNIT);
    assert.equal(naturalPace(6000, 0), PIXELS_PER_SPEED_UNIT);
    assert.equal(naturalPace(NaN, 10), PIXELS_PER_SPEED_UNIT);
    assert.equal(naturalPace(6000, 140, 0), PIXELS_PER_SPEED_UNIT);
});

test('a script paced naturally finishes in about its estimated reading time', () => {
    const contentHeight = 6000;
    const words = 140;                       // one minute at 140wpm
    const basePxPerSec = naturalPace(contentHeight, words);
    let p = 0;
    for (let i = 0; i < 60 * 60; i++) p = stepScroll(p, { dt: 1 / 60, speed: 1, basePxPerSec });
    assert.ok(Math.abs(p - contentHeight) < 5, `after a minute it had covered ${Math.round(p)} of ${contentHeight}px`);
});

test('the nearest word to the focus point is found', () => {
    const tops = [0, 50, 100, 150, 200];
    assert.equal(nearestWordIndex(tops, 0), 0);
    assert.equal(nearestWordIndex(tops, 98), 2);
    assert.equal(nearestWordIndex(tops, 102), 2);
    assert.equal(nearestWordIndex(tops, 200), 4);
    assert.equal(nearestWordIndex(tops, 9999), 4, 'past the end clamps to the last word');
    assert.equal(nearestWordIndex(tops, -50), 0, 'before the start clamps to the first');
});

test('ties and empty input are handled', () => {
    assert.equal(nearestWordIndex([0, 100], 50), 0, 'an exact tie takes the earlier word');
    assert.equal(nearestWordIndex([], 10), -1);
    assert.equal(nearestWordIndex(null, 10), -1);
});

test('words sharing a line all have the same offset, and that is fine', () => {
    // Several words per rendered line means repeated tops; the search must not
    // loop or overshoot on the duplicates.
    const tops = [0, 0, 0, 50, 50, 100];
    const i = nearestWordIndex(tops, 50);
    assert.ok(i === 3 || i === 4, `expected a word on the 50px line, got index ${i}`);
});

test('progress follows the scroll when there is no voice cursor to follow', () => {
    // Voice tracking normally drives the progress bar from the matcher's
    // cursor. With voice off that cursor never advances, so the bar would sit
    // at zero for the whole read — one of the two most visible things on
    // screen, frozen. Scroll position has to stand in for it.
    assert.equal(scrollProgress(0, 1000), 0);
    assert.equal(scrollProgress(250, 1000), 0.25);
    assert.equal(scrollProgress(1000, 1000), 1);
});

test('progress never runs past the end or behind the start', () => {
    // stepScroll clamps to maxPosition, but the focus-point maths can hand us a
    // position slightly past it, and a bar wider than 100% breaks the layout.
    assert.equal(scrollProgress(1200, 1000), 1);
    assert.equal(scrollProgress(-50, 1000), 0);
});

test('a script too short to scroll reports zero, not NaN or Infinity', () => {
    // A script that fits on one screen gives maxScroll <= 0. Dividing by it
    // would write "NaN%" or "Infinity%" straight into a style attribute.
    assert.equal(scrollProgress(0, 0), 0);
    assert.equal(scrollProgress(100, 0), 0);
    assert.equal(scrollProgress(100, -20), 0);
    assert.equal(scrollProgress(NaN, 1000), 0);
});
