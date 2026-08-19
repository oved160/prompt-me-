// A session that ran this long was working, not looping.
const HEALTHY_SESSION_MS = 2000;
const RESTART_BASE_MS = 250;
const RESTART_MAX_MS = 4000;

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

      if (finalText || interimText) {
        this.onEvent?.(`result "${(finalText || interimText).slice(0, 40)}"`);
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
    this.restarts += 1;
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

  stop() {
    this._wantRunning = false;
    this.recognition.abort(); // abort() stops immediately and does not trigger a result event
  }
}
