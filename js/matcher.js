// Recognizers write numbers as digits ("3 tools") while scripts are usually
// typed as words ("three tools"), or the other way round. Normalising both
// sides to one form stops a number from breaking the alignment.
const NUMBER_WORDS = {
  0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six',
  7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve',
  13: 'thirteen', 14: 'fourteen', 15: 'fifteen', 16: 'sixteen', 17: 'seventeen',
  18: 'eighteen', 19: 'nineteen', 20: 'twenty', 30: 'thirty', 40: 'forty',
  50: 'fifty', 60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety',
  100: 'hundred', 1000: 'thousand',
};

// Noises a speaker makes that are never in the script. Left in, they dilute the
// match ratio and drag a good chunk below the confidence gate.
const FILLERS = new Set(['uh', 'um', 'erm', 'mm', 'mmm', 'ah', 'eh', 'hmm']);

export function tokenize(text) {
  if (!text) return [];
  const words = [];
  for (const raw of text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f\u0591-\u05c7]/g, '') // Strip accents and Hebrew niqqud
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')            // Strip punctuation, keep any alphabet
    .split(/\s+/)) {
    if (!raw || FILLERS.has(raw)) continue;
    const asNumber = /^\d+$/.test(raw) ? NUMBER_WORDS[Number(raw)] : null;
    words.push(asNumber || raw);
  }
  return words;
}

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const currRow = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      currRow.push(Math.min(currRow[currRow.length - 1] + 1, prevRow[j + 1] + 1, prevRow[j] + cost));
    }
    prevRow = currRow;
  }
  return prevRow[b.length];
}

function similarity(a, b) {
  if (a === b) return 1.0;
  const dist = levenshtein(a, b);
  const sim = 1 - dist / Math.max(a.length, b.length);
  return sim >= 0.75 ? sim : 0;
}

export class ScriptMatcher {
  constructor(scriptText) {
    this.words = tokenize(scriptText);
    this.cursor = 0;
  }

  reset() {
    this.cursor = 0;
  }

  get progress() {
    return this.words.length === 0 ? 0 : this.cursor / this.words.length;
  }

  /**
   * @param {string} transcriptChunk  what was just heard
   * @param {object} [opts]
   * @param {number} [opts.lookBack]   words behind the cursor to consider
   * @param {number} [opts.lookAhead]  words ahead of the cursor to consider
   */
  update(transcriptChunk, { lookBack = 8, lookAhead = 60 } = {}) {
    const heard = tokenize(transcriptChunk);
    if (heard.length === 0 || this.words.length === 0) return this.cursor;

    // Window prevents matching common words in the wrong part of the script.
    // A wider window is only used to recover after the match has been lost.
    const winStart = Math.max(0, this.cursor - lookBack);
    const winEnd = Math.min(this.words.length, this.cursor + lookAhead);

    let bestScore = -1;
    let bestEndCursor = this.cursor;
    let bestMatchCount = 0;

    for (let i = winStart; i < winEnd; i++) {
      let sIdx = i;
      let hIdx = 0;
      let currentScore = 0;
      let currentMatches = 0;

      while (sIdx < winEnd && hIdx < heard.length) {
        let localBestSim = 0;
        let localSJump = 0;
        let localHJump = 0;

        // Greedy lookahead: check nearby words in both script and transcript
        for (let sJump = 0; sJump <= 3 && (sIdx + sJump) < winEnd; sJump++) {
          for (let hJump = 0; hJump <= 3 && (hIdx + hJump) < heard.length; hJump++) {
            const sim = similarity(this.words[sIdx + sJump], heard[hIdx + hJump]);
            if (sim > localBestSim) {
              localBestSim = sim;
              localSJump = sJump;
              localHJump = hJump;
            }
          }
        }

        if (localBestSim >= 0.75) {
          currentScore += localBestSim;
          currentMatches++;
          sIdx += localSJump + 1;
          hIdx += localHJump + 1;
        } else {
          hIdx++;
        }
      }

      // Confidence gate, applied per candidate: a candidate that scores high on
      // a couple of stray common words must not beat a weaker but honest match.
      const passesGate = currentMatches >= 2 && currentMatches / heard.length >= 0.5;
      if (passesGate && currentScore > bestScore) {
        bestScore = currentScore;
        bestEndCursor = sIdx;
        bestMatchCount = currentMatches;
      }
    }

    if (bestMatchCount >= 2) {
      // Guard: cursor must never move backwards
      this.cursor = Math.max(this.cursor, bestEndCursor);
    }

    return this.cursor;
  }
}
