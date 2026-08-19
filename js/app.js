import { ScriptMatcher, tokenize } from './matcher.js';
import { SpeechListener, isSpeechSupported } from './speech.js';
import { Recorder, saveRecording, pickMimeType } from './recorder.js';
import { stepScroll, FOCUS_RATIO } from './scroll.js';
import { TranscriptFeeder } from './transcript.js';
import { detectDirection } from './direction.js';

const STORE_KEY = 'prompt-me';
const WORDS_PER_MINUTE = 140;

const SAMPLE = `Hey, quick one. I used to spend my whole evening editing a two minute video, and most of that was just cutting out the parts where I lost my place.

So I started reading from a teleprompter. Not a fancy one. Just my phone, propped up next to the lens.

The difference was immediate. One take, eyes on camera, done in ten minutes.`;

let stream, matcher, listener, recorder;
let wordSpans = [];
let scrollPosition = 0;
let lastFrameTime = 0;
let rafHandle = null;
let lastPaintedCursor = -1;
let isPaused = false;
let isVoiceMode = false;
let hasStarted = false;
let lastAdvanceAt = 0;
let recordingInterval;
let stallTimer;
let wakeLock = null;
let recordBusy = false;
let pausedForSheet = false;
let pendingTake = null;   // a finished recording the user has not saved yet
let pendingTakeUrl = null;
let pendingTakeMs = 0;
let takesShot = 0;        // attempts rolled, kept or not, the way a slate counts
let currentTake = 0;      // the number on the take being shot or reviewed
let reviewDuration = 0;   // seconds, resolved for the review player

const dom = {};
for (const id of [
    'setup', 'script-input', 'lang-select', 'start-btn', 'setup-error', 'setup-note',
    'read-time', 'sample-btn',
    'prompter', 'camera', 'script-view', 'script-text', 'countdown',
    'rec-dot', 'rec-time', 'status', 'progress-bar', 'controls',
    'record-btn', 'rec-icon', 'play-pause', 'settings-btn', 'sheet', 'scrim', 'awake-state',
    'review', 'review-take', 'review-length', 'review-video', 'review-note', 'review-tap',
    'review-play', 'review-back', 'review-restart', 'review-seek', 'review-time',
    'save-take', 'retake', 'discard-take',
    'voice-toggle', 'mirror-toggle', 'restart-btn', 'back-btn', 'sheet-lang',
    'speed-range', 'font-range', 'opacity-range',
]) {
    dom[id] = document.getElementById(id);
}

const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 8 5.5Z"/></svg>';

/* ---------------------------------------------------------------- setup */

function init() {
    restorePreferences();

    dom['script-input'].addEventListener('input', updateReadTime);
    dom['sample-btn'].addEventListener('click', () => {
        dom['script-input'].value = SAMPLE;
        updateReadTime();
        dom['script-input'].focus();
    });
    dom['start-btn'].addEventListener('click', startApp);

    dom['play-pause'].addEventListener('click', () => {
        if (!hasStarted) beginReading();
        else setPaused(!isPaused);
    });
    dom['record-btn'].addEventListener('click', toggleRecording);
    dom['settings-btn'].addEventListener('click', () => openSheet(true));
    dom['rec-dot'].addEventListener('click', toggleRecordingPause);
    wireReviewPlayer();
    dom['save-take'].addEventListener('click', saveTake);
    dom['retake'].addEventListener('click', retake);
    dom['discard-take'].addEventListener('click', () => { discardTake(); leaveShoot(''); });
    dom['scrim'].addEventListener('click', () => openSheet(false));

    dom['voice-toggle'].addEventListener('click', () => setVoice(!isVoiceMode));
    dom['mirror-toggle'].addEventListener('click', toggleMirror);
    dom['restart-btn'].addEventListener('click', restart);
    dom['back-btn'].addEventListener('click', goBack);

    dom['font-range'].addEventListener('input', () => { applyFontSize(); savePreferences(); });
    dom['opacity-range'].addEventListener('input', () => { applyShade(); savePreferences(); });
    dom['speed-range'].addEventListener('input', savePreferences);
    dom['lang-select'].addEventListener('change', () => {
        dom['sheet-lang'].value = dom['lang-select'].value;
        savePreferences();
    });

    // Changing language mid-session has to actually take effect, otherwise the
    // stall message that points people here is a dead end.
    dom['sheet-lang'].addEventListener('change', () => {
        dom['lang-select'].value = dom['sheet-lang'].value;
        savePreferences();
        if (listener) {
            const wasOn = isVoiceMode;
            setVoice(false);
            listener = null; // rebuilt with the new language on next start
            if (wasOn) setVoice(true);
        }
        showStatus('');
    });

    // The whole script area is a pause target. On a phone, hunting for a small
    // button while reading is the thing that actually fails.
    dom['script-view'].addEventListener('click', () => {
        if (!dom['sheet'].hidden) return;
        if (!hasStarted) beginReading();
        else setPaused(!isPaused);
    });
    dom['prompter'].addEventListener('pointerdown', () => {
        // Any touch is a chance to reclaim a lock the system took away.
        if (!wakeLock) acquireWakeLock();
    });

    if (!isSpeechSupported) {
        dom['voice-toggle'].disabled = true;
        dom['voice-toggle'].setAttribute('aria-pressed', 'false');
        dom['voice-toggle'].textContent = 'Off';
    }
    if (!supportsRecording()) {
        dom['record-btn'].disabled = true;
    }

    // Tapping the grabber is the gesture people try first to dismiss a sheet.
    document.querySelector('.grabber')?.addEventListener('click', () => openSheet(false));

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Desktop convenience: space to pause, escape to close the sheet.
    document.addEventListener('keydown', (e) => {
        if (dom['prompter'].hidden) return;
        if (e.key === 'Escape' && !dom['sheet'].hidden) { openSheet(false); return; }
        if (e.code !== 'Space' || e.target.matches('input, textarea, select, button')) return;
        e.preventDefault();
        if (!hasStarted) beginReading();
        else setPaused(!isPaused);
    });

    updateReadTime();

    // Closing or refreshing mid-take would destroy it silently, so ask first.
    window.addEventListener('beforeunload', (e) => {
        if ((recorder && recorder.state !== 'inactive') || pendingTake) {
            e.preventDefault();
            e.returnValue = '';
            return;
        }
        stopAll();
    });
}

/**
 * A phone dimming and locking halfway through a take is the single most
 * annoying failure this app can have. The lock is dropped by the browser
 * whenever the page is hidden, so it has to be reclaimed on the way back.
 */
function setAwakeState(state) {
    const labels = {
        on: 'On',
        off: 'Dropped, tap the screen',
        blocked: 'Blocked by the phone',
        unsupported: 'Not supported here',
    };
    if (dom['awake-state']) dom['awake-state'].textContent = labels[state] || state;
}

async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) {
        setAwakeState('unsupported');
        return;
    }
    if (wakeLock) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        setAwakeState('on');
        // Android drops the lock on its own for battery saver, an incoming
        // call, or any moment the page stops being visible.
        wakeLock.addEventListener('release', () => {
            wakeLock = null;
            setAwakeState('off');
        });
    } catch {
        wakeLock = null;
        // Usually battery saver. The request is rejected outright.
        setAwakeState('blocked');
    }
}

async function releaseWakeLock() {
    try {
        await wakeLock?.release();
    } catch {
        // Already gone.
    }
    wakeLock = null;
}

function handleVisibilityChange() {
    if (document.visibilityState === 'visible' && !dom['prompter'].hidden) {
        acquireWakeLock();
    }
}

function supportsRecording() {
    return typeof MediaRecorder !== 'undefined' && !!pickMimeType();
}

function restorePreferences() {
    let saved;
    try {
        // JSON.parse succeeds on the literal "null", "0" and "false", so a
        // truthy-object check is needed as well as the catch. Without it a bad
        // stored value throws here, init() dies half-registered, and every
        // button in the app silently stops working.
        const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        saved = (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
        saved = {};
    }
    if (saved.script) dom['script-input'].value = saved.script;
    if (saved.lang) dom['lang-select'].value = saved.lang;
    dom['sheet-lang'].value = dom['lang-select'].value;
    if (saved.font) dom['font-range'].value = saved.font;
    if (saved.shade) dom['opacity-range'].value = saved.shade;
    if (saved.speed) dom['speed-range'].value = saved.speed;
    setMirror(saved.mirror !== false); // default on
    takesShot = Number.isFinite(saved.takes) ? saved.takes : 0;
    paintTakeNumber();
}

/**
 * A slate counts attempts, not keepers. Every time you roll, the number goes
 * up, whether or not that take survives. Counting only saved takes made the
 * number sit still across a whole session of retries.
 */
function nextTakeNumber() {
    return takesShot + 1;
}

function paintTakeNumber() {
    const label = `Take ${String(nextTakeNumber()).padStart(2, '0')}`;
    const slate = document.querySelector('.masthead .take');
    if (slate) slate.textContent = label;
}

function savePreferences() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
            script: dom['script-input'].value,
            lang: dom['lang-select'].value,
            font: dom['font-range'].value,
            shade: dom['opacity-range'].value,
            speed: dom['speed-range'].value,
            mirror: dom['camera'].classList.contains('mirrored'),
            takes: takesShot,
        }));
    } catch {
        // Private mode blocks storage. Losing preferences is not worth an error.
    }
}

function updateReadTime() {
    // Flip the editor to match what is actually being written, rather than
    // whichever character happened to be typed first.
    dom['script-input'].dir = detectDirection(dom['script-input'].value);

    const count = tokenize(dom['script-input'].value).length;
    if (!count) {
        dom['read-time'].textContent = 'No script yet';
        return;
    }
    const seconds = Math.round((count / WORDS_PER_MINUTE) * 60);
    const label = seconds < 60
        ? `${seconds} sec`
        : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} sec`;
    dom['read-time'].textContent = `${count} words, about ${label}`;
}

/* ---------------------------------------------------------------- start */

/**
 * Opens the camera and mic. Returns false and explains itself if it cannot,
 * leaving the caller on whatever screen it was on.
 */
async function openCamera() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            // Ask for a full quality capture. Without these the browser is free
            // to hand back 640x480, which is what makes recordings look cheap.
            video: {
                facingMode: 'user',
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 30 },
            },
            audio: { echoCancellation: true, noiseSuppression: true },
        });
        dom['camera'].srcObject = stream;
        return true;
    } catch (err) {
        showSetupError({
            NotAllowedError: 'Camera and microphone access was blocked. Allow it in your browser settings, then try again.',
            SecurityError: 'Camera and microphone access was blocked. Allow it in your browser settings, then try again.',
            // Very common in practice: another app still holds the camera.
            NotReadableError: 'Your camera is already in use by another app. Close it, then try again.',
            NotFoundError: 'No camera or microphone was found on this device.',
        }[err.name] || 'The camera could not be started on this device.');
        return false;
    }
}

/**
 * Shooting is over: drop the camera and mic so the indicator light goes out.
 * The script and its position are left alone so a retake can pick them up.
 */
function closeCamera() {
    setVoice(false);
    listener = null;
    clearInterval(stallTimer);
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
    dom['camera'].srcObject = null;
    releaseWakeLock();
    setPaused(true, true);
}

async function startApp() {
    const text = dom['script-input'].value.trim();
    if (!text) {
        showSetupError('Paste or type a script first.');
        dom['script-input'].focus();
        return;
    }
    savePreferences();

    if (!await openCamera()) return;

    showSetupError('');
    dom['setup-note'].hidden = true;
    dom['setup'].hidden = true;
    dom['prompter'].hidden = false;

    applyFontSize();
    applyShade();
    buildScript(text);
    startScrollLoop();

    // Hold at the top until the reader says go. Scrolling the moment the screen
    // appears means they are already behind before they have drawn breath.
    hasStarted = false;
    resetTranscript();
    setPaused(true, true);
    showStatus('Tap anywhere to begin');
    acquireWakeLock();
}

async function beginReading() {
    if (hasStarted) return;
    hasStarted = true;
    showStatus('');
    await runCountdown();

    // The reader can back out during the countdown. Without this the app would
    // start a recogniser and a scroll loop for a screen that is already gone.
    if (dom['prompter'].hidden) return;

    setPaused(false, true);

    if (isSpeechSupported) {
        setVoice(true);
    } else {
        showStatus('Voice pacing needs Chrome. Scrolling at a steady speed.');
    }
}

function buildScript(text) {
    matcher = new ScriptMatcher(text);
    dom['script-text'].dir = detectDirection(text);
    dom['script-text'].innerHTML = '';
    wordSpans = [];
    lastPaintedCursor = -1;

    // The script is laid out the way it was typed: one block per line, with
    // blank lines kept as breathing room. Reflowing it into one continuous
    // river destroys the phrasing the writer put there on purpose.
    //
    // Display keeps the original punctuation, the matcher works on stripped
    // tokens. Skipping chunks that tokenize to nothing keeps the indexes aligned.
    const frag = document.createDocumentFragment();
    for (const rawLine of text.split(/\r?\n/)) {
        const line = document.createElement('p');
        line.className = 'line';
        // The line's direction orders the words. Counting beats dir="auto",
        // which would flip a Hebrew line that opens with an English word.
        line.dir = detectDirection(rawLine);

        const chunks = rawLine.trim().split(/\s+/).filter(Boolean);
        if (chunks.length === 0) {
            line.classList.add('blank');
            frag.appendChild(line);
            continue;
        }

        for (const chunk of chunks) {
            if (tokenize(chunk).length === 0) continue;
            const span = document.createElement('span');
            span.className = 'word';
            // No per-word dir: forcing one would cut each word into a separate
            // bidi run and reverse consecutive English words inside a Hebrew
            // line. The line's dir plus the browser's own algorithm handles it.
            span.textContent = chunk;
            line.append(span, document.createTextNode(' '));
            wordSpans.push(span);
        }
        frag.appendChild(line);
    }
    dom['script-text'].appendChild(frag);
    paintProgress();
}

async function runCountdown() {
    dom['countdown'].hidden = false;
    for (let i = 3; i > 0; i--) {
        dom['countdown'].innerHTML = `<span>${i}</span>`;
        await new Promise(r => setTimeout(r, 900));
    }
    dom['countdown'].hidden = true;
    dom['countdown'].innerHTML = '';
}

/* ---------------------------------------------------------------- scroll */

function startScrollLoop() {
    // Two live loops would double the scroll speed.
    if (rafHandle !== null) return;
    scrollPosition = 0;
    lastFrameTime = 0;
    rafHandle = requestAnimationFrame(scrollLoop);
}

function stopScrollLoop() {
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    rafHandle = null;
}

function scrollLoop(now) {
    // A fresh loop has no previous frame, so the first delta must be zero
    // rather than a multi-second jump.
    const dt = lastFrameTime ? (now - lastFrameTime) / 1000 : 0;
    lastFrameTime = now;

    const currentSpan = matcher && wordSpans[matcher.cursor];
    const lastSpan = wordSpans[wordSpans.length - 1];
    scrollPosition = stepScroll(scrollPosition, {
        dt,
        paused: isPaused,
        voiceMode: isVoiceMode,
        speed: parseFloat(dom['speed-range'].value),
        wordTop: currentSpan ? currentSpan.offsetTop : null,
        viewportHeight: window.innerHeight,
        // Stop once the final line has settled around the focus point.
        maxPosition: lastSpan ? lastSpan.offsetTop - window.innerHeight * FOCUS_RATIO : Infinity,
    });

    dom['script-text'].style.transform = `translate3d(0, ${-scrollPosition}px, 0)`;
    rafHandle = requestAnimationFrame(scrollLoop);
}

/* ---------------------------------------------------------------- voice */

function setupVoice() {
    listener = new SpeechListener({
        lang: dom['lang-select'].value,
        onResult: ({ finalText, interimText }) => {
            if (isPaused) return;
            handleTranscript(finalText, interimText);
        },
        // Raw states only mean something while voice is on. Without this guard a
        // trailing 'stopped' overwrites the error explaining why it died.
        onStatus: (state) => {
            if (!isVoiceMode) return;
            const friendly = { listening: '', restarting: 'Reconnecting', stopped: '' };
            if (state in friendly) showStatus(friendly[state]);
        },
        onError: (message) => {
            setVoice(false);
            showStatus(`${message} Scrolling at a steady speed instead.`);
        },
    });
}

function setVoice(on) {
    if (on && !isSpeechSupported) return;
    isVoiceMode = on;
    dom['voice-toggle'].setAttribute('aria-pressed', String(on));
    dom['voice-toggle'].textContent = on ? 'On' : 'Off';

    if (on) {
        if (!listener) setupVoice();
        listener.start();
        lastAdvanceAt = performance.now();
        watchForStall();
    } else if (listener) {
        listener.stop();
        clearInterval(stallTimer);
    }
}

const feeder = new TranscriptFeeder();

function handleTranscript(finalText, interimText) {
    const text = finalText || interimText;
    if (!text) return;

    const context = feeder.next(text, Boolean(finalText));
    if (!context) return;

    // If the match has gone cold, widen the search so a reader who skipped
    // ahead or lost their place can be found again.
    const stalled = !!dom['status'].dataset.stalled;
    matcher.update(context, stalled ? { lookBack: 40, lookAhead: 250 } : undefined);
    paintProgress();
}

function resetTranscript() {
    feeder.reset();
}

function paintProgress() {
    const cursor = matcher ? matcher.cursor : 0;
    if (cursor === lastPaintedCursor) return;

    // Only repaint the span range that changed. Touching every span on each
    // result makes long scripts stutter.
    const from = Math.max(0, Math.min(lastPaintedCursor < 0 ? 0 : lastPaintedCursor, cursor));
    const to = Math.max(lastPaintedCursor, cursor);
    for (let i = from; i <= to && i < wordSpans.length; i++) {
        wordSpans[i].classList.toggle('said', i < cursor);
        wordSpans[i].classList.toggle('current', i === cursor);
    }
    lastPaintedCursor = cursor;
    lastAdvanceAt = performance.now();
    if (dom['status'].dataset.stalled) {
        showStatus('');
        delete dom['status'].dataset.stalled;
    }
    dom['progress-bar'].style.width = `${matcher ? matcher.progress * 100 : 0}%`;
}

/**
 * Voice pacing fails silently: bad mic, heavy background noise, or the wrong
 * language selected all look identical to the reader, a script that just sits
 * there. Say something rather than letting them wonder.
 */
function watchForStall() {
    clearInterval(stallTimer);
    stallTimer = setInterval(() => {
        if (!isVoiceMode || isPaused || !hasStarted) return;
        if (dom['status'].dataset.stalled) return;
        if (performance.now() - lastAdvanceAt < 8000) return;
        dom['status'].dataset.stalled = '1';
        showStatus('Not following your voice. Check the language in settings, or switch it off for steady scrolling.');
    }, 1000);
}

/* ---------------------------------------------------------------- controls */

function setPaused(paused, silent = false) {
    isPaused = paused;
    dom['play-pause'].innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
    dom['play-pause'].setAttribute('aria-pressed', String(paused));
    dom['play-pause'].setAttribute('aria-label', paused ? 'Resume scrolling' : 'Pause scrolling');
    if (!silent) flashPauseState(paused);

    // Pausing must stop the recogniser too. Otherwise it keeps matching while
    // the text is frozen and the script lurches forward on resume.
    if (listener && isVoiceMode) {
        if (paused) listener.stop();
        else listener.start();
    }
}

function flashPauseState(paused) {
    const flash = document.createElement('div');
    flash.id = 'pause-flash';
    flash.innerHTML = paused
        ? '<svg viewBox="0 0 24 24" width="34" height="34" fill="#fff"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>'
        : '<svg viewBox="0 0 24 24" width="34" height="34" fill="#fff"><path d="M8 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 8 5.5Z"/></svg>';
    dom['prompter'].appendChild(flash);
    setTimeout(() => flash.remove(), 700);
}

function openSheet(open) {
    dom['sheet'].hidden = !open;
    dom['scrim'].hidden = !open;
    dom['sheet'].setAttribute('aria-hidden', String(!open));

    // Adjusting the dimming or text size should not cost the reader their
    // place. Hold the script while the sheet is up, then hand control back.
    if (open) {
        pausedForSheet = hasStarted && !isPaused;
        if (pausedForSheet) setPaused(true, true);
        dom['sheet'].querySelector('input, button')?.focus();
    } else if (pausedForSheet) {
        pausedForSheet = false;
        setPaused(false, true);
    }
}

function toggleMirror() {
    // Mirror the camera only. Mirrored text would be unreadable.
    setMirror(!dom['camera'].classList.contains('mirrored'));
    savePreferences();
}

/**
 * On by default: a phone propped beside the lens is being used as a mirror, and
 * an unmirrored preview makes people correct the wrong way. The recording is
 * never affected, only the preview.
 */
function setMirror(on) {
    dom['camera'].classList.toggle('mirrored', on);
    dom['mirror-toggle'].setAttribute('aria-pressed', String(on));
    dom['mirror-toggle'].setAttribute('aria-label', on ? 'Turn off mirroring' : 'Mirror the camera');
}

function restart() {
    scrollPosition = 0;
    resetTranscript();
    if (matcher) matcher.reset();
    lastPaintedCursor = wordSpans.length - 1; // force a repaint back to the top
    paintProgress();
}

function applyFontSize() {
    dom['script-text'].style.setProperty('--font-size', `${dom['font-range'].value}px`);
}

function applyShade() {
    dom['script-view'].style.setProperty('--shade', dom['opacity-range'].value);
}

function showStatus(message) {
    dom['status'].textContent = message;
    if (!message) {
        dom['status'].classList.remove('actionable');
        dom['status'].onclick = null;
    }
}

function showSetupError(message) {
    dom['setup-error'].textContent = message;
    dom['setup-error'].hidden = !message;
}

/* ---------------------------------------------------------------- recording */

function timestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function toggleRecording() {
    // Starting involves a countdown, and saving involves an await. A second tap
    // in either gap would otherwise open a second recorder or a second save.
    if (recordBusy) return;
    recordBusy = true;
    try {
        await runRecordingToggle();
    } finally {
        recordBusy = false;
    }
}

async function runRecordingToggle() {
    // 'paused' still counts as an open recording: stopping must finish it,
    // not start a second one.
    if (recorder && recorder.state !== 'inactive') {
        await finishRecording();
        return;
    }
    if (!supportsRecording()) {
        showStatus('This browser cannot record video.');
        dom['record-btn'].disabled = true;
        return;
    }

    // Hitting record before the script is running should do the obvious thing:
    // count down once, then start both together.
    if (!hasStarted) await beginReading();

    recorder = new Recorder(stream);
    recorder.start();

    // The slate advances the moment you roll, so a session of retries is
    // numbered the way it actually happened.
    takesShot += 1;
    currentTake = takesShot;
    savePreferences();
    paintTakeNumber();

    dom['rec-dot'].hidden = false;
    dom['record-btn'].setAttribute('aria-pressed', 'true');
    dom['record-btn'].setAttribute('aria-label', 'Stop recording');
    recordingInterval = setInterval(() => {
        const sec = Math.floor(recorder.elapsedMs / 1000);
        dom['rec-time'].textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    }, 500);
}

/**
 * Pausing the take without ending it: the reader can cough, restart a sentence,
 * or reposition the phone, and still come out with one continuous file.
 */
function toggleRecordingPause() {
    if (!recorder) return;
    if (recorder.state === 'recording') {
        recorder.pause();
        dom['rec-dot'].dataset.paused = 'true';
        dom['rec-dot'].setAttribute('aria-label', 'Resume recording');
        dom['rec-icon'].innerHTML = '<path d="M8 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 8 5.5Z"/>';
        showStatus('Recording paused');
        // Hold the script too, so the two stay in step.
        setPaused(true, true);
    } else if (recorder.state === 'paused') {
        recorder.resume();
        delete dom['rec-dot'].dataset.paused;
        dom['rec-dot'].setAttribute('aria-label', 'Pause recording');
        dom['rec-icon'].innerHTML = '<rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/>';
        showStatus('');
        setPaused(false, true);
    }
}

async function finishRecording() {
    // Read the clock before stopping: an inactive recorder reports zero.
    const elapsed = recorder.elapsedMs;
    const blob = await recorder.stop();
    recorder = null;
    clearInterval(recordingInterval);
    dom['rec-dot'].hidden = true;
    delete dom['rec-dot'].dataset.paused;
    dom['rec-time'].textContent = '0:00';
    dom['record-btn'].setAttribute('aria-pressed', 'false');
    dom['record-btn'].setAttribute('aria-label', 'Start recording');
    showStatus('');
    if (!blob) return;

    pendingTake = blob;
    pendingTakeMs = elapsed;

    // Shooting is over, so the camera light should go out now rather than
    // staying on through the whole review.
    closeCamera();
    openReview();
}

/* ---------------------------------------------------------------- review */

function formatClock(ms) {
    // Floor, not round: a playhead at 1.5s of a 2s take must not read 0:02 / 0:02.
    const sec = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * Nothing is written to the device until the user has watched the take back and
 * asked for it. The blob lives in memory only, and is released on every exit.
 */
const ICON_PLAY_LG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 8 5.5Z"/></svg>';
const ICON_PAUSE_LG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>';

function openReview() {
    const video = dom['review-video'];
    pendingTakeUrl = URL.createObjectURL(pendingTake);
    video.src = pendingTakeUrl;
    // The recorded length is the reliable figure. A MediaRecorder blob usually
    // reports duration Infinity until it has been forced to resolve, which is
    // what breaks a plain <video controls> scrubber.
    reviewDuration = pendingTakeMs / 1000;
    resolveDuration(video);

    dom['review-take'].textContent = `Take ${String(currentTake).padStart(2, '0')}`;
    dom['review-length'].textContent = formatClock(pendingTakeMs);
    dom['review-note'].textContent = 'Check it before you keep it. Nothing has been saved yet.';
    setPlayIcon(false);
    paintPlayhead(0);
    dom['review'].hidden = false;
}

/**
 * Chrome reports Infinity for the duration of a blob it just recorded. Seeking
 * far past the end forces it to settle on the real value, after which the
 * scrubber and the time readout can be trusted.
 */
function resolveDuration(video) {
    video.addEventListener('loadedmetadata', function onMeta() {
        video.removeEventListener('loadedmetadata', onMeta);
        if (Number.isFinite(video.duration) && video.duration > 0) {
            reviewDuration = video.duration;
            // Prefer the file's own duration over the wall clock, so the header
            // and the player never disagree by a second.
            dom['review-length'].textContent = formatClock(reviewDuration * 1000);
            // Nudge off frame zero so the preview shows the take rather than
            // a black rectangle. Autoplay would have to be muted, and half the
            // point of a review is hearing it.
            video.currentTime = 0.05;
            return;
        }
        video.currentTime = 1e101;
        video.addEventListener('timeupdate', function onTick() {
            video.removeEventListener('timeupdate', onTick);
            if (Number.isFinite(video.duration) && video.duration > 0) {
                reviewDuration = video.duration;
            // Prefer the file's own duration over the wall clock, so the header
            // and the player never disagree by a second.
            dom['review-length'].textContent = formatClock(reviewDuration * 1000);
            }
            video.currentTime = 0.05;
        });
    });
}

function setPlayIcon(playing) {
    dom['review-play'].innerHTML = playing ? ICON_PAUSE_LG : ICON_PLAY_LG;
    dom['review-play'].setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function paintPlayhead(seconds) {
    const total = reviewDuration || 0;
    const pct = total > 0 ? Math.min(100, (seconds / total) * 100) : 0;
    dom['review-seek'].value = String(Math.round(pct * 10));
    dom['review-seek'].style.setProperty('--played', `${pct}%`);
    dom['review-time'].textContent = `${formatClock(seconds * 1000)} / ${formatClock(total * 1000)}`;
}

function togglePlayback() {
    const video = dom['review-video'];
    if (video.paused) video.play().catch(() => {});
    else video.pause();
}

function nudgePlayhead(deltaSeconds) {
    const video = dom['review-video'];
    const total = reviewDuration || 0;
    video.currentTime = Math.max(0, Math.min(total ? total - 0.05 : Infinity, video.currentTime + deltaSeconds));
}

function wireReviewPlayer() {
    const video = dom['review-video'];
    video.addEventListener('play', () => setPlayIcon(true));
    video.addEventListener('pause', () => setPlayIcon(false));
    video.addEventListener('ended', () => { setPlayIcon(false); paintPlayhead(reviewDuration); });
    video.addEventListener('timeupdate', () => {
        // Ignore the huge seek used to resolve the duration.
        if (Number.isFinite(video.currentTime) && video.currentTime < 1e6) paintPlayhead(video.currentTime);
    });

    dom['review-play'].addEventListener('click', togglePlayback);
    dom['review-tap'].addEventListener('click', togglePlayback);
    dom['review-back'].addEventListener('click', () => nudgePlayhead(-5));
    dom['review-restart'].addEventListener('click', () => { video.currentTime = 0; paintPlayhead(0); });
    dom['review-seek'].addEventListener('input', () => {
        const total = reviewDuration || 0;
        if (!total) return;
        const seconds = (Number(dom['review-seek'].value) / 1000) * total;
        video.currentTime = seconds;
        paintPlayhead(seconds);
    });
}

function closeReview() {
    dom['review'].hidden = true;
    dom['review-video'].pause();
    dom['review-video'].removeAttribute('src');
    dom['review-video'].load();
    if (pendingTakeUrl) URL.revokeObjectURL(pendingTakeUrl);
    pendingTakeUrl = null;
    reviewDuration = 0;
}

function discardTake() {
    closeReview();
    pendingTake = null;
    pendingTakeMs = 0;
}

async function saveTake() {
    if (!pendingTake) return;
    const name = `prompt-me-take-${String(currentTake).padStart(2, '0')}-${timestamp()}`;
    dom['save-take'].disabled = true;
    dom['review-note'].textContent = 'Saving';
    try {
        const result = await saveRecording(pendingTake, name);
        if (result.method === 'cancelled') {
            // A dismissed share sheet is a routine slip, so the take stays put.
            dom['review-note'].textContent = 'Not saved. The take is still here, try again when you are ready.';
            return;
        }
        discardTake();
        leaveShoot(result.method === 'share'
            ? 'Saved. Pick Photos in the share sheet to keep it in your gallery.'
            : 'Saved to your downloads.');
    } catch {
        dom['review-note'].textContent = 'That did not save. The take is still here, try again.';
    } finally {
        dom['save-take'].disabled = false;
    }
}

/** Discard the take and go straight back to the top of the script to shoot again. */
async function retake() {
    discardTake();
    if (!await openCamera()) {
        // The camera could not be reopened, so there is nothing to shoot with.
        leaveShoot('');
        return;
    }
    restart();
    hasStarted = false;
    resetTranscript();
    setPaused(true, true);
    startScrollLoop();
    acquireWakeLock();
    showStatus('Tap anywhere to begin');
}

/** Leaves the prompter for the setup screen, with the camera already released. */
function leaveShoot(message) {
    stopAll();
    dom['prompter'].hidden = true;
    dom['setup'].hidden = false;
    updateReadTime();
    showSetupError('');
    dom['setup-note'].textContent = message;
    dom['setup-note'].hidden = !message;
}

/* ---------------------------------------------------------------- teardown */

async function goBack() {
    openSheet(false);

    // Never discard a recording just because the user tapped Edit, including
    // one that is currently paused. Finishing it opens the review screen, and
    // the user leaves from there once they have decided what to keep.
    if (recorder && recorder.state !== 'inactive') {
        await finishRecording();
        return;
    }
    stopAll();
    dom['prompter'].hidden = true;
    dom['setup'].hidden = false;
    updateReadTime();
}

function stopAll() {
    stopScrollLoop();
    closeReview();
    clearInterval(stallTimer);
    hasStarted = false;
    resetTranscript();
    releaseWakeLock();
    if (listener) listener.stop();
    if (recordingInterval) clearInterval(recordingInterval);
    if (stream) stream.getTracks().forEach(t => t.stop());
    dom['camera'].srcObject = null;

    listener = null;
    recorder = null;
    stream = null;
    isVoiceMode = false;
    isPaused = false;
    showStatus('');
    dom['rec-dot'].hidden = true;
    dom['voice-toggle'].setAttribute('aria-pressed', String(isSpeechSupported));
    dom['voice-toggle'].textContent = isSpeechSupported ? 'On' : 'Off';
}

init();
