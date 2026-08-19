import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptFeeder } from '../js/transcript.js';
import { ScriptMatcher } from '../js/matcher.js';

test('a long utterance is fed on its own, with no borrowed context', () => {
    const f = new TranscriptFeeder();
    f.next('line one has three words', true);
    // The next utterance is long enough to place by itself. Prepending the tail
    // of the previous one would read as a repeated phrase.
    assert.equal(f.next('line one has three words', true), 'line one has three words');
});

test('a very short fragment borrows context from the previous utterance', () => {
    const f = new TranscriptFeeder();
    f.next('the quick brown fox jumps', true);
    assert.equal(f.next('over', false), 'quick brown fox jumps over');
});

test('the context window is capped', () => {
    const f = new TranscriptFeeder({ contextWords: 5 });
    const out = f.next('one two three four five six seven eight', true);
    assert.deepEqual(out.split(' '), ['four', 'five', 'six', 'seven', 'eight']);
});

test('empty and filler-only input yields nothing', () => {
    const f = new TranscriptFeeder();
    assert.equal(f.next('', false), '');
    assert.equal(f.next('um uh', false), '');
});

test('reset clears the borrowed context', () => {
    const f = new TranscriptFeeder();
    f.next('the quick brown fox jumps', true);
    f.reset();
    assert.equal(f.next('over', false), 'over');
});

test('replaying an utterance never advances the cursor twice', () => {
    // The regression this class exists for: the same words arriving again, as
    // interim then final, must not walk the script forward.
    const script = 'Line one has three words. Line two follows after that.';
    const m = new ScriptMatcher(script);
    const f = new TranscriptFeeder();

    for (const t of ['line', 'line one', 'line one has', 'line one has three']) {
        m.update(f.next(t, false));
    }
    m.update(f.next('line one has three words', true));
    const settled = m.cursor;

    m.update(f.next('line one has three words', true));
    m.update(f.next('line one has three words', true));
    assert.equal(m.cursor, settled, `cursor crept from ${settled} to ${m.cursor}`);
});

test('a growing interim stream tracks forward without overshooting', () => {
    const m = new ScriptMatcher('Hey everyone welcome back to the channel today');
    const f = new TranscriptFeeder();
    let previous = 0;
    for (const t of ['hey', 'hey everyone', 'hey everyone welcome', 'hey everyone welcome back']) {
        m.update(f.next(t, false));
        assert.ok(m.cursor >= previous, 'cursor went backwards');
        previous = m.cursor;
    }
    assert.ok(m.cursor >= 3 && m.cursor <= 4, `expected to sit around word 4, got ${m.cursor}`);
});
