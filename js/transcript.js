import { tokenize } from './matcher.js';

/**
 * Turns the stream of speech-recognition results into something the matcher can
 * align against.
 *
 * Interim results arrive as a growing, repeatedly revised string: "line",
 * "line one", "line one has". Feeding each one whole means the same words get
 * aligned again and again. A very short fragment, though, carries too little
 * information to place confidently, so it borrows a few words from the end of
 * the previous utterance as context.
 *
 * The catch is that borrowed context must never be added to an utterance that
 * is already long enough to stand alone: "one has three words" followed by
 * "line one has three words" reads as a repeated phrase, and the matcher walks
 * forward over the duplicate.
 */
export class TranscriptFeeder {
    constructor({ contextWords = 12, standaloneAt = 3, tailWords = 4 } = {}) {
        this.contextWords = contextWords;
        this.standaloneAt = standaloneAt;
        this.tailWords = tailWords;
        this.reset();
    }

    reset() {
        this.previousTail = [];
        this.currentTokens = [];
    }

    /**
     * @param {string} text        the transcript to process
     * @param {boolean} isFinal    whether the recognizer considers it complete
     * @returns {string} the text to align, or '' when there is nothing to do
     */
    next(text, isFinal) {
        this.currentTokens = tokenize(text);
        if (this.currentTokens.length === 0) {
            if (isFinal) this.finish();
            return '';
        }

        const standalone = this.currentTokens.length >= this.standaloneAt;
        const context = standalone
            ? this.currentTokens
            : [...this.previousTail, ...this.currentTokens];

        const result = context.slice(-this.contextWords).join(' ');
        if (isFinal) this.finish();
        return result;
    }

    finish() {
        if (this.currentTokens.length) {
            this.previousTail = this.currentTokens.slice(-this.tailWords);
        }
        this.currentTokens = [];
    }
}
