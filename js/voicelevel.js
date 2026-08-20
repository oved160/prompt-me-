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
 *
 * The governing rule, learned the hard way: NEVER FREEZE. A prompter that
 * scrolls when it should not is irritating; one that sits still while you talk
 * is unusable. Every judgement call below resolves towards moving.
 */

export const DEFAULTS = {
    // How much louder than the room's own hum counts as a voice.
    margin: 2.2,
    // Never treat near-silence as speech, however quiet the room is.
    absoluteFloor: 0.006,
    // Keep going through the short gaps between words, so the script does not
    // stutter to a halt on every consonant.
    holdMs: 420,
    // The noise floor is the quietest moment in the last few seconds. Speech has
    // dips between words, so its minimum sits near room tone even mid-sentence.
    blockMs: 500,
    blocks: 6,
    /**
     * The floor is never allowed above this, no matter how loud the room is.
     * Without a ceiling a loud room, or speech mistaken for room tone, raises
     * the bar above the reader's own voice and the script stops dead. Past this
     * point the gate cannot be trusted, so it lets everything through instead.
     */
    floorCeiling: 0.02,
    // An analyser producing literal digital silence this long is not working:
    // a suspended AudioContext, or a track that was never live.
    deadAfterMs: 2000,
};

export class SpeechActivity {
    constructor(options = {}) {
        this.opts = { ...DEFAULTS, ...options };
        this.reset();
    }

    reset() {
        // Seeded at the absolute floor, not at whatever the first sample happens
        // to be. Calibrating on the first sample was the bug that made this
        // useless in practice: the reader starts talking the moment the
        // countdown clears, so the first sample IS speech, the floor lands at
        // speaking level, and their voice can never clear the bar it just set.
        this.mins = new Array(this.opts.blocks).fill(this.opts.absoluteFloor);
        this.blockMin = Infinity;
        this.blockStart = -1;
        this.startedAt = -1;
        this.lastLoudAt = -Infinity;
        this.lastSoundAt = -Infinity;
        this.speaking = false;
    }

    /** The quietest recent moment, capped so it can never exceed a voice. */
    get floor() {
        return Math.min(Math.min(...this.mins), this.opts.floorCeiling);
    }

    /**
     * @param {number} rms   0..1 loudness of the latest audio frame
     * @param {number} now   milliseconds, monotonic
     * @returns {boolean} whether the reader should be treated as speaking
     */
    update(rms, now) {
        const { absoluteFloor, margin, holdMs, blockMs } = this.opts;

        if (this.startedAt < 0) {
            this.startedAt = now;
            this.blockStart = now;
        }

        this.blockMin = Math.min(this.blockMin, rms);
        if (now - this.blockStart >= blockMs) {
            this.mins.push(this.blockMin);
            this.mins.shift();
            this.blockMin = Infinity;
            this.blockStart = now;
        }

        if (rms > absoluteFloor) this.lastSoundAt = now;

        const threshold = Math.max(this.floor * margin, absoluteFloor);
        if (rms > threshold) this.lastLoudAt = now;

        this.speaking = now - this.lastLoudAt < holdMs;
        return this.speaking;
    }

    /**
     * True when the analyser has delivered nothing but digital silence for long
     * enough that it is broken rather than quiet. The caller should stop gating
     * on it: a gate that can only ever say "no" holds the script forever.
     */
    isDeaf(now) {
        if (this.startedAt < 0) return false;
        const { deadAfterMs } = this.opts;
        return now - this.startedAt > deadAfterMs && now - this.lastSoundAt > deadAfterMs;
    }
}

/** RMS of a float time-domain buffer, the cheapest honest measure of loudness. */
export function rmsOf(samples) {
    if (!samples || samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
}
