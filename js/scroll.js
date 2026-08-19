/**
 * The scroll position is the one piece of continuous state in the app, and it
 * is the easiest thing to get subtly wrong. Keeping the step function pure
 * means it can be tested without a browser, a camera, or a running clock.
 */

export const PIXELS_PER_SPEED_UNIT = 40;   // at speed 1, scroll 40px per second
export const FOCUS_RATIO = 0.1;            // current word sits right at the top, by the camera lens
export const EASING = 0.08;                // fraction of the remaining gap per frame
export const MAX_FRAME_SECONDS = 0.1;      // ignore gaps longer than this

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
        return Math.min(position + (target - position) * EASING, maxPosition);
    }
    return Math.min(position + speed * PIXELS_PER_SPEED_UNIT * safeDt, maxPosition);
}
