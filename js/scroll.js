/**
 * The scroll position is the one piece of continuous state in the app, and it
 * is the easiest thing to get subtly wrong. Keeping the step function pure
 * means it can be tested without a browser, a camera, or a running clock.
 */

export const PIXELS_PER_SPEED_UNIT = 40;   // fallback pace when the script's own is unknown
/**
 * Where the word being read sits, as a fraction of the screen height.
 *
 * High, because the lens is at the top of the phone and the whole point is to
 * read while looking down it. Not AT the top though: at 0.1 the reading line
 * sat close to the edge and near the script mask's own fade, which made it feel
 * cramped and clipped.
 *
 * #script-text's top padding in index.html must match this. At rest the first
 * word sits exactly on the focus line, so that padding is
 * (viewport height * FOCUS_RATIO); change one without the other and the script
 * starts already scrolled.
 */
export const FOCUS_RATIO = 0.18;
export const MAX_FRAME_SECONDS = 0.1;      // ignore gaps longer than this

/**
 * How quickly the scroll converges on the word being spoken, per second.
 *
 * Deliberately expressed per second rather than per frame. A fixed fraction
 * per frame means a 120Hz phone eases twice as fast as a 60Hz one and a
 * throttled tab crawls, so the same script paces differently on every device.
 */
export const EASE_RATE = 12;

/**
 * Advance the scroll position by one frame.
 *
 * @param {number} position       current offset in pixels
 * @param {object} opts
 * @param {number} opts.dt        seconds since the previous frame
 * @param {boolean} opts.paused
 * @param {boolean} opts.voiceMode
 * @param {number} opts.speed     multiplier from the speed slider
 * @param {number|null} opts.wordTop  offsetTop of the current word, null if none
 * @param {number} opts.viewportHeight
 * @param {number} [opts.maxPosition]  furthest the script can scroll
 * @param {number} [opts.basePxPerSec] the script's own natural reading pace
 * @returns {number} the new position
 */
export function stepScroll(position, {
    dt,
    paused = false,
    voiceMode = false,
    speed = 1,
    wordTop = null,
    viewportHeight = 800,
    maxPosition = Infinity,
    basePxPerSec = PIXELS_PER_SPEED_UNIT,
} = {}) {
    if (paused) return position;

    /*
     * A script short enough to fit above the focus point produces a NEGATIVE
     * maxPosition: the caller works it out as (last word's offsetTop − focus
     * offset), and on a one-line script that is roughly 6px − 81px = −75px.
     * Returning it below would scroll the script DOWNWARDS, out of the frame,
     * on the very first frame — the whole script vanishing the instant the
     * reader starts. Nothing may ever scroll above the top of the script.
     */
    const limit = Math.max(0, maxPosition);

    // Past the last word there is nothing left to reveal. Without this the
    // constant-speed fallback keeps winding an empty screen upward forever.
    if (position >= limit) return limit;

    // A backgrounded tab stops firing frames. When it resumes, the elapsed time
    // would otherwise be applied in one go and throw the reader far down the page.
    const safeDt = Math.max(0, Math.min(dt, MAX_FRAME_SECONDS));

    if (voiceMode && wordTop !== null) {
        const target = wordTop - viewportHeight * FOCUS_RATIO;
        // Exponential convergence on the target, framerate independent.
        const factor = 1 - Math.exp(-EASE_RATE * safeDt);
        return Math.min(position + (target - position) * factor, limit);
    }
    return Math.min(position + speed * basePxPerSec * safeDt, limit);
}

/**
 * The word sitting closest to the focus point, given each word's offset.
 *
 * Used when the script is pacing by sound rather than by recognition: nothing
 * knows which word was spoken, but the prompter still knows where it has
 * scrolled to, and showing that is honest where inventing a position is not.
 *
 * @param {number[]} tops    each word's offsetTop, ascending
 * @param {number} focusY    the position under the focus line
 * @returns {number} index of the nearest word, -1 when there are none
 */
export function nearestWordIndex(tops, focusY) {
    if (!tops || tops.length === 0) return -1;

    let lo = 0;
    let hi = tops.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tops[mid] < focusY) lo = mid + 1;
        else hi = mid;
    }
    // lo is the first word at or past the focus point; the one before it may sit closer.
    if (lo > 0 && Math.abs(tops[lo - 1] - focusY) <= Math.abs(tops[lo] - focusY)) return lo - 1;
    return lo;
}

/**
 * Groups words into the visual rows they actually render on.
 *
 * Scrolling is vertical, so a scroll position can only ever tell you which ROW
 * the reader is on — never which word within it, because every word on a row
 * shares one offsetTop. Highlighting a single word from a scroll position
 * therefore snaps to whichever word happens to start a row, holds there for the
 * whole row, then jumps the row's entire width at once. Rows hold different
 * numbers of words, so those jumps are different sizes, and the highlight looks
 * like it is moving at random. Rows are the honest unit.
 *
 * Note this is the RENDERED row, not the typed line: a long typed line wraps
 * into several rows, and the reader follows the wrapped ones.
 *
 * @param {number[]} tops  each word's offsetTop, in document order
 * @returns {{tops: number[], rowOfWord: number[], firstWord: number[], lastWord: number[]}}
 */
export function groupIntoRows(tops) {
    const rows = { tops: [], rowOfWord: [], firstWord: [], lastWord: [] };
    if (!tops || tops.length === 0) return rows;

    for (let i = 0; i < tops.length; i++) {
        // offsetTop never decreases in document order, so a larger value is a
        // new row. Equal values are more words on the row already open.
        if (rows.tops.length === 0 || tops[i] > rows.tops[rows.tops.length - 1]) {
            rows.tops.push(tops[i]);
            rows.firstWord.push(i);
            rows.lastWord.push(i);
        } else {
            rows.lastWord[rows.lastWord.length - 1] = i;
        }
        rows.rowOfWord.push(rows.tops.length - 1);
    }
    return rows;
}

/**
 * Which word the reader should be on, estimated from the scroll position.
 *
 * Taking the nearest word to the focus point does not work: every word on a row
 * shares one offsetTop, so it snaps to whichever word begins a row, holds there
 * for the row's whole height, then jumps the row's entire width at once. Rows
 * hold different numbers of words, so those jumps come out at 4, 1, 3, 2 words
 * and the highlight looks like it is moving at random.
 *
 * So interpolate ACROSS the row instead. As the scroll travels down one row's
 * height, the reader is travelling along that row's words, and the fraction of
 * the way down maps to the fraction of the way along. That is the same
 * assumption the scroll itself already rests on — naturalPace() sets the speed
 * from the script's own word count — so this is no more of a guess than the
 * pacing is, and it advances one word at a time.
 *
 * @param {{tops: number[], firstWord: number[], lastWord: number[]}} rows
 * @param {number} focusY  the scroll position under the focus line
 * @returns {number} word index, or -1 when there is nothing to point at
 */
export function wordAtScroll(rows, focusY) {
    if (!rows || !rows.tops || rows.tops.length === 0) return -1;

    // The row the focus point is INSIDE, which is the last one at or above it.
    // Deliberately not the nearest: nearest flips to the next row halfway down
    // the current one, cutting every row's second half off the highlight.
    let row = 0;
    let lo = 0;
    let hi = rows.tops.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (rows.tops[mid] <= focusY) { row = mid; lo = mid + 1; } else { hi = mid - 1; }
    }

    const first = rows.firstWord[row];
    const last = rows.lastWord[row];
    const wordsHere = last - first + 1;

    // Height of this row, taken from the gap to the next one. The final row has
    // no next, so it borrows the previous gap rather than dividing by zero.
    let rowHeight = row + 1 < rows.tops.length
        ? rows.tops[row + 1] - rows.tops[row]
        : (row > 0 ? rows.tops[row] - rows.tops[row - 1] : 0);
    if (!(rowHeight > 0)) return first;

    const through = Math.min(1, Math.max(0, (focusY - rows.tops[row]) / rowHeight));
    return Math.min(last, first + Math.floor(through * wordsHere));
}

/**
 * How far through the script the reader is, 0..1, from the scroll alone.
 *
 * Voice tracking normally drives the progress bar from the matcher's cursor,
 * which only advances when words are recognised. Without it that cursor never
 * moves and the bar sits at zero for the entire read. Scroll position answers
 * the same question honestly and without a microphone.
 *
 * @param {number} position   current offset in pixels
 * @param {number} maxScroll  furthest the script can scroll
 * @returns {number} 0..1, and 0 rather than NaN or Infinity for a script that
 *   is too short to scroll at all
 */
export function scrollProgress(position, maxScroll) {
    if (!(maxScroll > 0) || !Number.isFinite(position)) return 0;
    return Math.min(1, Math.max(0, position / maxScroll));
}

/**
 * The pace a script reads at, in pixels per second, from its own length.
 *
 * A fixed 40px/s is a guess that suits one font size and one script. Deriving
 * it from how tall the rendered script actually is, over how long it should
 * take to say, means the steady pace matches the writing rather than the
 * other way round.
 *
 * @param {number} contentHeight  rendered height of the script, in pixels
 * @param {number} wordCount
 * @param {number} [wordsPerMinute]
 */
export function naturalPace(contentHeight, wordCount, wordsPerMinute = 140) {
    if (!(contentHeight > 0) || !(wordCount > 0) || !(wordsPerMinute > 0)) {
        return PIXELS_PER_SPEED_UNIT;
    }
    const seconds = (wordCount / wordsPerMinute) * 60;
    if (!(seconds > 0)) return PIXELS_PER_SPEED_UNIT;
    return contentHeight / seconds;
}
