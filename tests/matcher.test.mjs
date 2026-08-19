import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, ScriptMatcher } from '../js/matcher.js';

const SCRIPT =
  'Hey everyone, welcome back to the channel. Today I want to show you three ' +
  'tools that completely changed how I edit my videos. Stick around to the end, ' +
  'because the third one is free.';

test('tokenize strips punctuation and case', () => {
  assert.deepEqual(tokenize('Hey, everyone!'), ['hey', 'everyone']);
});

test('tokenize keeps Hebrew words', () => {
  assert.deepEqual(tokenize('שלום, מה קורה?'), ['שלום', 'מה', 'קורה']);
});

test('tokenize normalizes digits to words so "3" matches "three"', () => {
    assert.deepEqual(tokenize('3 tools'), ['three', 'tools']);
    assert.deepEqual(tokenize('three tools'), ['three', 'tools']);
    // Years and long numbers have no word form, so they are left alone.
    assert.deepEqual(tokenize('in 2026'), ['in', '2026']);
});

test('tokenize drops filler noises', () => {
    assert.deepEqual(tokenize('um hey uh everyone'), ['hey', 'everyone']);
});

test('a spoken number matches a written one', () => {
    const m = new ScriptMatcher('I want to show you 3 tools that changed everything');
    m.update('i want to show you three tools that changed');
    assert.ok(m.cursor >= 7, `number normalisation failed, cursor=${m.cursor}`);
});

test('fillers do not drag a good match below the confidence gate', () => {
    const m = new ScriptMatcher(SCRIPT);
    m.update('um hey uh everyone um welcome back');
    assert.ok(m.cursor >= 4, `fillers broke the match, cursor=${m.cursor}`);
});

test('a wide window recovers when the reader has skipped ahead', () => {
    const long = new ScriptMatcher(
        'one two three four five six seven eight nine ten ' +
        Array.from({ length: 90 }, (_, i) => `filler${i}`).join(' ') +
        ' the very last sentence of the whole script here'
    );
    // Far beyond the default 60 word look-ahead.
    long.update('the very last sentence of the whole script');
    assert.equal(long.cursor, 0, 'default window should not reach that far');

    long.update('the very last sentence of the whole script', { lookBack: 40, lookAhead: 250 });
    assert.ok(long.cursor > 90, `recovery search failed, cursor=${long.cursor}`);
});

test('re-feeding the same rolling context does not creep the cursor forward', () => {
    const m = new ScriptMatcher(SCRIPT);
    m.update('hey everyone welcome back to the channel');
    const settled = m.cursor;
    // The app re-sends an overlapping window on every interim result.
    m.update('hey everyone welcome back to the channel');
    m.update('hey everyone welcome back to the channel');
    assert.equal(m.cursor, settled, `cursor crept from ${settled} to ${m.cursor}`);
});

test('tokenize handles empty input', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('reading the script aloud advances the cursor', () => {
  const m = new ScriptMatcher(SCRIPT);
  m.update('hey everyone welcome back to the channel');
  assert.ok(m.cursor >= 6, `expected cursor past the first line, got ${m.cursor}`);
});

test('misheard words still advance (fuzzy, not exact)', () => {
  const m = new ScriptMatcher(SCRIPT);
  // "welcom" and "chanel" are typical recognizer slips
  m.update('hey everyone welcom back to the chanel');
  assert.ok(m.cursor >= 6, `fuzzy match failed, cursor=${m.cursor}`);
});

test('a skipped word does not stall the cursor', () => {
  const m = new ScriptMatcher(SCRIPT);
  m.update('hey everyone welcome to the channel'); // dropped "back"
  assert.ok(m.cursor >= 6, `cursor stalled at ${m.cursor}`);
});

test('unrelated speech does not move the cursor', () => {
  const m = new ScriptMatcher(SCRIPT);
  m.update('hey everyone welcome back to the channel');
  const before = m.cursor;
  m.update('sorry hold on the dog is barking again');
  assert.equal(m.cursor, before);
});

test('cursor never moves backwards', () => {
  const m = new ScriptMatcher(SCRIPT);
  m.update('today i want to show you three tools');
  const before = m.cursor;
  m.update('hey everyone welcome back to the channel'); // re-reads the opening
  assert.ok(m.cursor >= before, `cursor went backwards: ${before} -> ${m.cursor}`);
});

test('reading through reaches the end', () => {
  const m = new ScriptMatcher(SCRIPT);
  m.update('hey everyone welcome back to the channel');
  m.update('today i want to show you three tools that completely changed');
  m.update('how i edit my videos stick around to the end');
  m.update('because the third one is free');
  assert.ok(m.progress > 0.9, `progress only reached ${m.progress.toFixed(2)}`);
});

test('reset returns to the start', () => {
  const m = new ScriptMatcher(SCRIPT);
  m.update('hey everyone welcome back to the channel');
  m.reset();
  assert.equal(m.cursor, 0);
  assert.equal(m.progress, 0);
});

test('empty script and empty chunk are safe', () => {
  const empty = new ScriptMatcher('');
  assert.equal(empty.update('anything at all'), 0);
  assert.equal(empty.progress, 0);
  const m = new ScriptMatcher(SCRIPT);
  assert.equal(m.update(''), 0);
});

test('a Hebrew script tracks Hebrew speech', () => {
  const he = new ScriptMatcher('שלום לכולם ברוכים הבאים לערוץ שלי היום נדבר על שיווק דיגיטלי');
  he.update('שלום לכולם ברוכים הבאים לערוץ שלי');
  assert.ok(he.cursor >= 5, `Hebrew matching failed, cursor=${he.cursor}`);
});
