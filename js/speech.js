export const isSpeechSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

export class SpeechListener {
  constructor({ lang = 'en-US', onResult, onStatus, onError } = {}) {
    this.lang = lang;
    this.onResult = onResult;
    this.onStatus = onStatus;
    this.onError = onError;

    this._wantRunning = false;
    this._restartCount = 0;
    this._firstRestartTime = 0;

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
        this.onResult?.({ finalText, interimText });
      }
    };

    this.recognition.onerror = (event) => {
      const error = event.error;
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
      if (this._wantRunning) {
        this._handleAutoRestart();
      } else {
        this.onStatus?.('stopped');
      }
    };
  }

  _handleAutoRestart() {
    const now = Date.now();
    
    // Guard against restart storms: if the API crashes/stops repeatedly in a loop
    if (now - this._firstRestartTime > 10000) {
      this._firstRestartTime = now;
      this._restartCount = 0;
    }

    this._restartCount++;

    if (this._restartCount > 5) {
      this._wantRunning = false;
      this.onError?.('Too many automatic restarts. Stopping to prevent loop.');
      this.onStatus?.('stopped');
      return;
    }

    this.onStatus?.('restarting');
    setTimeout(() => {
      if (this._wantRunning) this.start();
    }, 250);
  }

  start() {
    this._wantRunning = true;
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
