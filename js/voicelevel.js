/**
 * Pacing a script by how loud the room is, rather than by what was said.
 *
 * Word-level tracking needs the Web Speech API, and on Android that API cannot
 * hold the microphone while a recording holds it. The recording's own audio
 * track, though, is already open and already ours to read. Its level says when
 * someone is talking, which is enough to keep a teleprompter moving: advance
 * while there is a voice, hold still in the gaps.
 *
 * It is deliberately not word matching. It cannot tell where in the script the
 * reader is, only whether they are speaking, so it is used during a take, where
 * the alternative is a script that scrolls on regardless.
 */

export const DEFAULTS = {
    // How much louder than the room's own hum counts as a voice.
    margin: 2.2,
    // Never treat near-silence as speech, however quiet the room is.
    absoluteFloor: 0.006,
    // Keep going through the short gaps between words, so the script does not
    // stutter to a halt on every consonant.
    holdMs: 420,
    // The floor follows a quiet room quickly and a loud one slowly, so a sudden
    // noise cannot raise the bar and lock the reader out.
    fallRate: 0.05,
    riseRate: 0.002,
};

export class SpeechActivity {
    constructor(options = {}) {
        this.opts = { ...DEFAULTS, ...options };
        this.reset();
    }

    reset() {
        this.floor = 0;
        this.speaking = false;
        this.lastLoudAt = -Infinity;
        this.started = false;
    }

    /**
     * @param {number} rms   0..1 loudness of the latest audio frame
     * @param {number} now   milliseconds, monotonic
     * @returns {boolean} whether the reader should be treated as speaking
     */
    update(rms, now) {
        const { margin, absoluteFloor, holdMs, fallRate, riseRate } = this.opts;

        if (!this.started) {
            // Start the floor at the first sample instead of climbing from zero,
            // which would otherwise call the first half second speech.
            this.floor = rms;
            this.started = true;
        } else {
            const rate = rms < this.floor ? fallRate : riseRate;
            this.floor += (rms - this.floor) * rate;
        }

        const threshold = Math.max(this.floor * margin, absoluteFloor);
        if (rms > threshold) this.lastLoudAt = now;

        this.speaking = now - this.lastLoudAt < holdMs;
        return this.speaking;
    }
}

/** RMS of a float time-domain buffer, the cheapest honest measure of loudness. */
export function rmsOf(samples) {
    if (!samples || samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
}
