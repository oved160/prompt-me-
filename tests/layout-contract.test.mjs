import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FOCUS_RATIO } from '../js/scroll.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the script padding matches FOCUS_RATIO', () => {
    // These two numbers are one decision expressed in two files. At rest the
    // first word must sit exactly on the focus line, so #script-text's top
    // padding has to be (viewport height * FOCUS_RATIO). Change one alone and
    // the script opens already scrolled, or with a gap above the first line —
    // a silent, whole-app-wide wrongness with nothing to catch it. This project
    // has already shipped that exact class of bug once, with --shade and the
    // dimming slider disagreeing.
    const m = html.match(/#script-text\s*\{[^}]*?padding:\s*([\d.]+)dvh/s);
    assert.ok(m, 'could not find #script-text padding-top in index.html');
    const paddingDvh = parseFloat(m[1]);
    assert.equal(paddingDvh / 100, FOCUS_RATIO,
        `#script-text padding-top is ${paddingDvh}dvh but FOCUS_RATIO is ${FOCUS_RATIO} ` +
        `(expected ${FOCUS_RATIO * 100}dvh)`);
});

test('the dimming slider default matches the --shade token', () => {
    // The same class of bug, and the one that actually shipped: applyShade()
    // writes the slider's value over the stylesheet's default on startup, so a
    // mismatch silently undoes the legibility the CSS asks for.
    const token = html.match(/--shade:\s*([\d.]+)\s*;/);
    const slider = html.match(/id="opacity-range"[^>]*value="([\d.]+)"/);
    assert.ok(token && slider, 'could not find --shade or the dimming slider');
    assert.equal(parseFloat(slider[1]), parseFloat(token[1]),
        `slider default ${slider[1]} does not match --shade ${token[1]}`);
});

test('the speed slider default matches its printed readout', () => {
    // The readout is static markup until the first input event, so a mismatch
    // means the sheet opens claiming a pace the app is not using.
    const slider = html.match(/id="speed-range"[^>]*value="(\d+)"/);
    const readout = html.match(/id="speed-readout"[^>]*>(\d+)\s*wpm</);
    assert.ok(slider && readout, 'could not find the speed slider or its readout');
    assert.equal(readout[1], slider[1],
        `readout says ${readout[1]}wpm but the slider defaults to ${slider[1]}`);
});

test('the speed range covers real reading paces and nothing absurd', () => {
    const m = html.match(/id="speed-range"[^>]*min="(\d+)"[^>]*max="(\d+)"/);
    assert.ok(m, 'could not find the speed slider range');
    const [min, max] = [Number(m[1]), Number(m[2])];
    // The bug this replaces: a 0.2-3 multiplier spanned 28-420wpm, so most of
    // the track was faster than anyone reads and the usable band was a fifth of
    // the slider. Normal speech is roughly 110-170wpm; the range should sit
    // around that, not dwarf it.
    assert.ok(min >= 60 && min <= 110, `min ${min}wpm is outside a usable floor`);
    assert.ok(max >= 180 && max <= 260, `max ${max}wpm is outside a usable ceiling`);
});
