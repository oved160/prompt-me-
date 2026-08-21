/**
 * A session shorter than this ended so fast that nothing can have happened in
 * it, which is the tight loop worth guarding against.
 *
 * It used to be two seconds, which was wrong and quietly broke voice tracking.
 * Chrome on Android ignores `continuous` and ends a session after every
 * utterance, normally after one or two seconds
 * (https://issues.chromium.org/issues/40324711). Calling that a fault meant
 * six ordinary utterances pushed the backoff to its four second ceiling, so
 * the recogniser spent most of the take switched off and heard almost nothing.
 */
const HEALTHY_SESSION_MS = 300;
/** Speech spoken between sessions is lost, so the gap is kept short. */
const RESTART_BASE_MS = 100;
const RESTART_MAX_MS = 4000;

/**
 * A documented Android platform bug: mid-utterance, the native recognizer can
 * get stuck delivering the SAME interim text over and over while the speaker
 * keeps talking, and `onend` never fires to let the normal restart logic
 * notice. From the outside it looks alive (events keep arriving) while it has
 * actually stopped listening. Nothing short of tearing it down and starting a
 * fresh session recovers it, so that is done on a timer rather than waiting
 * for an `onend` that is not coming.
 * https://github.com/WebAudio/web-speech-api/issues/136
 */
const STUCK_TRANSCRIPT_MS = 4000;
const STUCK_CHECK_INTERVAL_MS = 1000;

export const isSpeechSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

export class SpeechListener {
  constructor({ lang = 'en-US', onResult, onStatus, onError, onEvent } = {}) {
    this.lang = lang;
    this.onResult = onResult;
    this.onStatus = onStatus;
    this.onError = onError;
    this.onEvent = onEvent; // raw event tap, for diagnostics

    this._wantRunning = false;
    this._restartCount = 0;
    this._sessionStart = 0;
    this.restarts = 0; // exposed for diagnostics
    this._lastTranscript = '';
    this._lastProgressAt = 0;
    this._stuckTimer = null;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      throw new Error('Speech Recognition API is not supported in this browser.');
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;
    this.recognition.lang = this.lang;

    this._initEventListeners();
  }

  get running() {
    return this._wantRunning;
  }

  _initEventListeners() {
    this.recognition.onstart = () => {
      this.onEvent?.('start');
      this.onStatus?.('listening');
    };

    this.recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += transcript;
        } else {
          interimText += transcript;
        }
      }

      const heard = finalText || interimText;
      if (heard) {
        this.onEvent?.(`result "${heard.slice(0, 40)}"`);
        // Only text that actually advanced counts as progress. Chrome fires
        // onresult again for the identical hypothesis while stuck, and
        // counting those would hide the exact failure this guards against.
        if (heard !== this._lastTranscript || finalText) {
          this._lastTranscript = heard;
          this._lastProgressAt = Date.now();
        }
        this.onResult?.({ finalText, interimText });
      }
    };

    this.recognition.onerror = (event) => {
      const error = event.error;
      this.onEvent?.(`error ${error}`);
      if (['no-speech', 'audio-capture', 'aborted'].includes(error)) {
        this.onStatus?.(`error: ${error}`);
        // These are non-fatal; let the 'end' event handle the restart logic
      } else if (['not-allowed', 'service-not-allowed'].includes(error)) {
        this._wantRunning = false;
        this.onError?.('Microphone access denied. Please allow microphone permissions.');
      } else if (error === 'network') {
        this.onError?.('Network error. Chrome speech recognition requires an internet connection.');
      } else {
        this.onError?.(`Speech recognition error: ${error}`);
      }
    };

    this.recognition.onend = () => {
      this.onEvent?.('end');
      if (this._wantRunning) {
        this._handleAutoRestart();
      } else {
        this.onStatus?.('stopped');
      }
    };
  }

  /**
   * Chrome ends a recognition session constantly on Android: after each
   * utterance, after a pause, sometimes immediately. Restarting is the normal
   * state of affairs, not an emergency.
   *
   * The previous guard counted restarts and gave up permanently after five in
   * ten seconds, which a phone reaches within seconds of starting. Voice
   * tracking would switch itself off almost immediately and never return.
   *
   * What actually needs guarding against is a *tight* loop: end firing
   * instantly, over and over, which would spin the CPU. That is detectable by
   * how long the session lasted, not by how many there were. A session with
   * any real duration resets the backoff; only instant failures back off, and
   * even then it keeps trying rather than abandoning the user.
   */
  _handleAutoRestart() {
    const lasted = Date.now() - this._sessionStart;

    if (lasted > HEALTHY_SESSION_MS) {
      this._restartCount = 0;
    } else {
      this._restartCount++;
    }

    const delay = Math.min(
      RESTART_BASE_MS * Math.pow(2, Math.max(0, this._restartCount - 1)),
      RESTART_MAX_MS
    );

    this.onStatus?.('restarting');
    setTimeout(() => {
      if (this._wantRunning) this.start();
    }, delay);
  }

  start() {
    this._wantRunning = true;
    this._sessionStart = Date.now();
    this._lastTranscript = '';
    this._lastProgressAt = Date.now();
    this.restarts += 1;
    this._armStuckWatch();
    try {
      this.recognition.start();
    } catch (e) {
      // Chrome throws InvalidStateError if start() is called while already running.
      // We swallow this because the intent is simply "ensure it is running".
      if (e.name === 'InvalidStateError') {
        return;
      }
      throw e;
    }
  }

  _armStuckWatch() {
    clearInterval(this._stuckTimer);
    this._stuckTimer = setInterval(() => {
      if (!this._wantRunning) return;
      if (Date.now() - this._lastProgressAt < STUCK_TRANSCRIPT_MS) return;
      this._forceRestart();
    }, STUCK_CHECK_INTERVAL_MS);
    // A watchdog should never be the reason a process stays alive. Browsers
    // have no unref, where this is a no-op; under Node it stops the timer
    // holding the event loop open after the work is done.
    this._stuckTimer?.unref?.();
  }

  /**
   * Nothing new arrived for STUCK_TRANSCRIPT_MS while still supposedly
   * listening. On the Android bug this guards against, `onend` never fires on
   * its own to let the normal restart logic notice, so this forces the issue:
   * abort the stuck session, and if that alone does not produce a fresh one
   * shortly, start one directly rather than trust a browser event that has
   * already shown it might not come.
   */
  _forceRestart() {
    const sessionAtCallTime = this._sessionStart;
    this._lastProgressAt = Date.now(); // do not re-trigger every tick while recovering
    this.onEvent?.('stuck, forcing restart');
    try {
      this.recognition.abort();
    } catch {
      // Already on its way out.
    }
    setTimeout(() => {
      if (this._wantRunning && this._sessionStart === sessionAtCallTime) {
        // abort() did not produce a new session either; start one directly.
        this.start();
      }
    }, 600);
  }

  stop() {
    this._wantRunning = false;
    clearInterval(this._stuckTimer);
    this._stuckTimer = null;
    this.recognition.abort(); // abort() stops immediately and does not trigger a result event
  }
}
