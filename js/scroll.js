/**
 * The scroll position is the one piece of continuous state in the app, and it
 * is the easiest thing to get subtly wrong. Keeping the step function pure
 * means it can be tested without a browser, a camera, or a running clock.
 */

export const PIXELS_PER_SPEED_UNIT = 40;   // fallback pace when the script's own is unknown
export const FOCUS_RATIO = 0.1;            // current word sits right at the top, by the camera lens
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
    // Past the last word there is nothing left to reveal. Without this the
    // constant-speed fallback keeps winding an empty screen upward forever.
    if (position >= maxPosition) return maxPosition;

    // A backgrounded tab stops firing frames. When it resumes, the elapsed time
    // would otherwise be applied in one go and throw the reader far down the page.
    const safeDt = Math.max(0, Math.min(dt, MAX_FRAME_SECONDS));

    if (voiceMode && wordTop !== null) {
        const target = wordTop - viewportHeight * FOCUS_RATIO;
        // Exponential convergence on the target, framerate independent.
        const factor = 1 - Math.exp(-EASE_RATE * safeDt);
        return Math.min(position + (target - position) * factor, maxPosition);
    }
    return Math.min(position + speed * basePxPerSec * safeDt, maxPosition);
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
