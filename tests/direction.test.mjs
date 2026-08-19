import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDirection } from '../js/direction.js';

test('plain English runs left to right', () => {
    assert.equal(detectDirection('Hey everyone, welcome back'), 'ltr');
});

test('plain Hebrew runs right to left', () => {
    assert.equal(detectDirection('שלום לכולם, ברוכים הבאים'), 'rtl');
});

test('a Hebrew line that OPENS with an English word stays right to left', () => {
    // The bug this module exists for. dir="auto" reads the first strong
    // character and would lay this whole line out backwards.
    assert.equal(detectDirection('teleprompt הוא הכלי שבניתי בשביל זה'), 'rtl');
});

test('a Hebrew line with an English word inside it stays right to left', () => {
    assert.equal(detectDirection('לא נורא בשביל זה בניתי את teleprompt'), 'rtl');
});

test('an English line inside a Hebrew script still runs left to right', () => {
    assert.equal(detectDirection('Download it from the App Store today'), 'ltr');
});

test('digits and punctuation do not decide the direction', () => {
    // Neutral characters outnumber the letters here, but the letters win.
    assert.equal(detectDirection('3 כלים!!! (2026) ...'), 'rtl');
    assert.equal(detectDirection('3 tools!!! (2026) ...'), 'ltr');
});

test('Arabic is treated as right to left', () => {
    assert.equal(detectDirection('مرحبا بالجميع'), 'rtl');
});

test('empty, whitespace and symbol-only text default to left to right', () => {
    assert.equal(detectDirection(''), 'ltr');
    assert.equal(detectDirection(null), 'ltr');
    assert.equal(detectDirection('   '), 'ltr');
    assert.equal(detectDirection('123 456 !!!'), 'ltr');
});

test('a single Hebrew word among many English ones does not flip the line', () => {
    assert.equal(detectDirection('The Hebrew word for peace is שלום'), 'ltr');
});
