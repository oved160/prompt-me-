import { ScriptMatcher, tokenize } from './matcher.js';
import { SpeechListener, isSpeechSupported } from './speech.js';
import { Recorder, shareRecording, downloadRecording, canShareVideo, pickMimeType } from './recorder.js';
import { stepScroll, naturalPace, nearestWordIndex, FOCUS_RATIO } from './scroll.js';
import { TranscriptFeeder } from './transcript.js';
import { detectDirection } from './direction.js';
import { SpeechActivity, rmsOf } from './voicelevel.js';
import { coverCrop, verticalSize, VERTICAL_ASPECT } from './framing.js';

const STORE_KEY = 'prompt-me';
/**
 * Bumped whenever a slider's default changes. savePreferences() writes the
 * sliders on startup whether or not they were touched, so an old default gets
 * stored as though it were a deliberate choice and the new one never reaches
 * anyone who used the app before. On a version change the sliders fall back to
 * their current defaults; the script, language and take count are kept.
 */
const STORE_VERSION = 2;

/**
 * Every browser on iOS is WebKit underneath, Chrome included, and Web Speech is
 * either missing or too unreliable to pace a script there. Worth naming: the
 * API can appear to exist and then simply never return a result.
 */
// User agent only. The usual "MacIntel plus touch points" trick for spotting an
// iPad also flags any touch-capable Mac, and telling a desktop user their
// iPhone is the problem is worse than missing an iPad.
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent);
const WORDS_PER_MINUTE = 140;

/**
 * MVP scope: ship the time-based teleprompter (speed slider, recording,
 * sharing) as the default product. Voice tracking is real and tested
 * (js/speech.js, js/matcher.js, js/voicelevel.js, and the lab/bench harnesses
 * under docs/) but its on-device feasibility during a recording is still
 * unresolved — see docs/local-stt-progress.md. Gating it here rather than
 * deleting it: every voice-tracking code path stays intact, tested, and one
 * flag away from returning as a premium feature once that question is
 * answered, instead of being rebuilt from a git history dig.
 */
const VOICE_TRACKING_ENABLED = false;

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
let voiceState = 'idle';  // last state reported by the recogniser
let voiceError = '';
let voiceHeard = 0;       // phrases the recogniser has actually returned
let voicePreferred = true; // the user's own choice, persisted
let lastHeardAt = 0;      // when the recogniser last returned anything
let voiceLogStart = 0;
let levelContext = null;   // Web Audio graph reading the recording's own audio
let levelAnalyser = null;
let levelBuffer = null;
let levelPacing = false;
const levelDetector = new SpeechActivity();
let composeCanvas = null;  // canvas the vertical recording is drawn onto
let composeHandle = null;
let recordStream = null;   // what MediaRecorder is actually fed
let basePxPerSec = 40;     // the script's own reading pace, in pixels per second
let takeVoiceWatch = null; // watchdog deciding whether word tracking survives a take
let wordTops = [];         // each word's offsetTop, for locating the focus point

const dom = {};
for (const id of [
    'setup', 'script-input', 'lang-select', 'start-btn', 'setup-error', 'setup-note',
    'read-time', 'sample-btn', 'clear-btn',
    'prompter', 'camera', 'script-view', 'script-text', 'countdown',
    'rec-dot', 'rec-time', 'status', 'progress-bar', 'controls',
    'record-btn', 'rec-icon', 'play-pause', 'settings-btn', 'sheet', 'scrim', 'awake-state',
    'voice-state', 'hearing', 'hearing-label', 'diag-btn', 'diag-out',
    'review', 'review-take', 'review-length', 'review-video', 'review-note', 'review-tap',
    'review-play', 'review-back', 'review-restart', 'review-seek', 'review-time',
    'share-take', 'save-take', 'retake', 'discard-take',
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
    // The script otherwise sits in browser storage forever. On a shared or
    // borrowed phone, whatever was last written stays readable to the next person.
    dom['clear-btn'].addEventListener('click', () => {
        dom['script-input'].value = '';
        try { localStorage.removeItem(STORE_KEY); } catch { /* private mode */ }
        updateReadTime();
        dom['setup-note'].hidden = true;
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
    dom['share-take'].addEventListener('click', shareTake);
    dom['save-take'].addEventListener('click', saveTake);
    dom['retake'].addEventListener('click', retake);
    dom['discard-take'].addEventListener('click', () => { discardTake(); leaveShoot(''); });
    dom['scrim'].addEventListener('click', () => openSheet(false));
    dom['diag-btn'].addEventListener('click', copyDiagnostics);

    dom['voice-toggle'].addEventListener('click', () => setVoice(!isVoiceMode, true));
    dom['mirror-toggle'].addEventListener('click', toggleMirror);
    dom['restart-btn'].addEventListener('click', restart);
    dom['back-btn'].addEventListener('click', goBack);

    dom['font-range'].addEventListener('input', () => { applyFontSize(); measurePace(); savePreferences(); });
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
    if (!VOICE_TRACKING_ENABLED) {
        // Hide rather than disable: a greyed-out control still tells someone
        // there is a feature they can't have, which is a worse MVP than not
        // mentioning it. Every element carrying this attribute is untouched
        // markup, so flipping the flag brings the whole feature straight back.
        document.querySelectorAll('[data-voice-feature]').forEach((el) => { el.hidden = true; });
    }

    // Tapping the grabber is the gesture people try first to dismiss a sheet.
    document.querySelector('.grabber')?.addEventListener('click', () => openSheet(false));

    document.addEventListener('visibilitychange', handleVisibilityChange);
    // Rotating the phone or the URL bar sliding away changes how tall the
    // script renders, and with it the pace it should scroll at.
    window.addEventListener('resize', () => { if (!dom['prompter'].hidden) measurePace(); });

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
/**
 * A phone cannot be attached to a debugger mid-take, so the app has to be able
 * to say what the recogniser is actually doing. "Heard N" separates the two
 * failure modes that look identical from the outside: a recogniser that never
 * started, and one that is running but whose words are not matching the script.
 */
/**
 * The on-screen "can it hear me" badge. Updated every second while reading, so
 * a dead microphone announces itself instead of looking like a script that
 * simply is not moving.
 */
function paintHearing() {
    const badge = dom['hearing'];
    if (!badge) return;

    const active = isVoiceMode && hasStarted && !dom['prompter'].hidden;
    badge.hidden = !active;
    if (!active) return;

    const sinceHeard = performance.now() - lastHeardAt;
    if (voiceHeard === 0) {
        badge.dataset.live = sinceHeard > 6000 ? 'deaf' : 'false';
        dom['hearing-label'].textContent = sinceHeard > 6000 ? 'Cannot hear you' : 'Listening';
    } else if (sinceHeard < 2500) {
        badge.dataset.live = 'true';
        dom['hearing-label'].textContent = 'Hearing you';
    } else {
        badge.dataset.live = 'false';
        dom['hearing-label'].textContent = 'Listening';
    }
}

/**
 * Confirmed on real Android hardware: the moment a recording claims the
 * microphone, the Web Speech API cannot get it too. Recognition keeps
 * starting, gets aborted a couple of seconds in, restarts, and never hears
 * a word, for as long as the recording holds the mic. This is not something
 * retrying harder fixes; only one of the two can have the microphone.
 *
 * So recording wins outright: voice pacing is paused for the length of the
 * take, scrolling runs at the steady speed instead of freezing on the last
 * word it heard, and the microphone is asked for only now, not held for the
 * whole session the way it used to be.
 */
async function acquireMicForRecording() {
    try {
        const mic = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
        });
        mic.getAudioTracks().forEach(t => stream.addTrack(t));
        recordStream = buildVerticalStream(mic);

        // Set the sound-level graph up, but do not pace by it yet. Real word
        // tracking is better, so try to keep it and only fall back if this
        // device genuinely refuses to run both at once.
        // Word tracking cannot run during a take, and this is settled rather
        // than assumed. An isolated test on the reporting device (lab.html,
        // TEST C) started a recorder and a recogniser side by side with no
        // watchdogs or restarts of any kind. The recogniser fired onaudiostart,
        // onsoundstart and onspeechstart, so it was receiving the microphone
        // perfectly well, and then returned zero results across thirteen
        // seconds of speech and raised no error at all. Chrome transcribes on
        // Google's servers; the local half works and the transcription half
        // goes silent while a recording is active.
        //
        // So recognition is stopped once, cleanly, rather than being torn down
        // and restarted on three separate timers while it fails to do something
        // it cannot do. Sound pacing carries the take, and word tracking comes
        // straight back when the take ends.
        if (isVoiceMode) setVoice(false);

        await prepareLevelPacing(mic);
        // Pace by sound from the very first frame. Waiting to find out whether
        // recognition survives left the script sitting still for six seconds at
        // the top of every take, which is exactly the delay it looked like.
        levelPacing = true;
        showStatus('Following the sound of your voice while recording.');
        return true;
    } catch {
        // Better a silent video than no take at all, but say so.
        showStatus('Recording without sound: the microphone could not be opened.');
        return false;
    }
}

/**
 * Builds the stream that actually gets recorded: the camera frame cropped to
 * vertical on a canvas, plus the microphone.
 *
 * Phones shoot vertical, so that is the default. Doing the crop here rather
 * than asking the camera for a portrait shape is what avoids the zoom, and it
 * has a better property besides: the crop is the same one the preview applies,
 * so the file matches what the reader framed up.
 */
function buildVerticalStream(micStream) {
    const video = dom['camera'];
    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    const { width, height } = verticalSize(srcW, srcH);

    composeCanvas = document.createElement('canvas');
    composeCanvas.width = width;
    composeCanvas.height = height;
    const ctx = composeCanvas.getContext('2d', { alpha: false });

    const draw = () => {
        if (!composeCanvas) return;
        // Read the size every frame: a camera can renegotiate mid-session.
        const w = video.videoWidth || srcW;
        const h = video.videoHeight || srcH;
        if (w && h) {
            const { sx, sy, sw, sh } = coverCrop(w, h, width, height);
            ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
        }
        composeHandle = requestAnimationFrame(draw);
    };
    draw();

    const composed = composeCanvas.captureStream(30);
    micStream.getAudioTracks().forEach(t => composed.addTrack(t));
    return composed;
}

function stopVerticalStream() {
    if (composeHandle !== null) cancelAnimationFrame(composeHandle);
    composeHandle = null;
    composeCanvas = null;
}

/** Builds the analyser but does not pace by it: that is decided separately. */
async function prepareLevelPacing(micStream) {
    stopLevelPacing();
    try {
        levelContext = new (window.AudioContext || window.webkitAudioContext)();
        // It is built after awaiting getUserMedia, so the tap that started the
        // take no longer counts as user activation and Android starts it
        // suspended. A suspended context feeds the analyser pure digital
        // silence forever, which reads exactly like a dead microphone: the gate
        // concludes it cannot hear anything and switches itself off, leaving
        // nothing pacing the script at all.
        if (levelContext.state === 'suspended') {
            await levelContext.resume().catch(() => {});
        }
        const source = levelContext.createMediaStreamSource(micStream);
        levelAnalyser = levelContext.createAnalyser();
        levelAnalyser.fftSize = 1024;
        levelAnalyser.smoothingTimeConstant = 0.4;
        source.connect(levelAnalyser);
        levelBuffer = new Float32Array(levelAnalyser.fftSize);
        levelDetector.reset();
    } catch {
        // No Web Audio: the steady speed is the only fallback left.
        levelAnalyser = null;
        levelBuffer = null;
    }
}

function stopLevelPacing() {
    levelPacing = false;
    levelAnalyser = null;
    levelBuffer = null;
    if (levelContext) {
        levelContext.close().catch(() => {});
        levelContext = null;
    }
}

/**
 * True when the reader is audibly speaking. Cheap enough to call every frame.
 *
 * Note which way every failure resolves: a missing analyser, or one that turns
 * out to be producing nothing, returns true so the script keeps moving. The
 * gate is only ever allowed to hold the script when it is genuinely hearing
 * the room and that room is quiet.
 */
function readerIsSpeaking() {
    if (!levelPacing || !levelAnalyser || !levelBuffer) return true;

    levelAnalyser.getFloatTimeDomainData(levelBuffer);
    const now = performance.now();
    const speaking = levelDetector.update(rmsOf(levelBuffer), now);

    if (levelDetector.isDeaf(now)) {
        // Nothing but digital silence: a suspended AudioContext, or a track
        // that never went live. Gating on it would freeze the take.
        levelPacing = false;
        showStatus('Cannot hear the microphone, so the script scrolls at a steady speed.');
        return true;
    }
    return speaking;
}

function paintVoiceState() {
    if (!dom['voice-state']) return;

    // Answer the only question worth asking here: is voice tracking working?
    // Reporting the recogniser's momentary state was useless, because opening
    // this sheet pauses the script and stops the recogniser, so the readout
    // described the act of looking at it rather than the take.
    let label;
    if (!isSpeechSupported) label = 'Not available in this browser';
    else if (!voicePreferred) label = 'Off';
    else if (voiceHeard) label = `Working, heard ${voiceHeard}`;
    else if (IS_IOS) label = 'Will not run on iPhone';
    else label = 'On, nothing heard yet';

    const extras = [];
    // A high restart count with nothing heard is the signature of a recogniser
    // that keeps being handed the microphone and getting nothing from it.
    if (!voiceHeard && listener && listener.restarts > 3) extras.push(`${listener.restarts} restarts`);
    // The last real failure is sticky. It used to be overwritten a moment later
    // by the "stopped" that always follows an error, hiding the actual cause.
    if (voiceError) extras.push(voiceError);
    dom['voice-state'].textContent = [label, ...extras].join(' · ');
}

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
    const sameVersion = saved.v === STORE_VERSION;
    if (saved.script) dom['script-input'].value = saved.script;
    if (saved.lang) dom['lang-select'].value = saved.lang;
    dom['sheet-lang'].value = dom['lang-select'].value;
    if (saved.font && sameVersion) dom['font-range'].value = saved.font;
    if (saved.shade && sameVersion) dom['opacity-range'].value = saved.shade;
    if (saved.speed && sameVersion) dom['speed-range'].value = saved.speed;
    setMirror(saved.mirror !== false); // default on
    voicePreferred = saved.voice !== false; // default on
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
            v: STORE_VERSION,
            script: dom['script-input'].value,
            lang: dom['lang-select'].value,
            font: dom['font-range'].value,
            shade: dom['opacity-range'].value,
            speed: dom['speed-range'].value,
            mirror: dom['camera'].classList.contains('mirrored'),
            voice: voicePreferred,
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
            // Video only, deliberately. On real Android hardware a live
            // getUserMedia audio track and the Web Speech API fight over the
            // microphone: the recogniser starts, gets aborted every couple of
            // seconds, and never hears a word, for as long as that track is
            // open. Audio is requested only for the few seconds a recording
            // actually needs it, in acquireMicForRecording().
            // Ask for a full quality capture and nothing more. Forcing a
            // portrait shape here made Chrome crop the sensor's native frame
            // and scale it up, which zoomed the picture hard into the middle
            // of the reader's face. The camera's own aspect is left alone.
            video: {
                facingMode: 'user',
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 30 },
            },
        });
        dom['camera'].srcObject = stream;
        // One source of truth for the shape: the preview is held to exactly the
        // aspect the recording is cropped to, so the two cannot drift apart.
        dom['camera'].style.aspectRatio = String(VERTICAL_ASPECT);
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
    clearTimeout(takeVoiceWatch);
    stopLevelPacing();
    stopVerticalStream();
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
    voiceHeard = 0;
    voiceError = '';
    voiceState = 'idle';
    paintVoiceState();
    setPaused(true, true);
    showStatus('Tap anywhere to begin');
    acquireWakeLock();
}

async function beginReading() {
    if (hasStarted) return;
    hasStarted = true;
    showStatus('');

    // Start listening inside the tap that triggered this, BEFORE the countdown.
    // Browsers only allow speech recognition to start while a user gesture is
    // still in scope, and awaiting three seconds of countdown first throws that
    // away. Nobody is speaking during the countdown, so nothing is lost.
    // Honour a deliberate "off". Forcing voice back on every take would put the
    // microphone back on Google's servers for someone who switched it off
    // precisely to stop that.
    if (VOICE_TRACKING_ENABLED && isSpeechSupported && voicePreferred) {
        setVoice(true);
    } else if (VOICE_TRACKING_ENABLED && !isSpeechSupported) {
        showStatus('Voice pacing needs Chrome on Android or a desktop. Scrolling at a steady speed.');
    }

    await runCountdown();

    // The reader can back out during the countdown. Without this the app would
    // start a recogniser and a scroll loop for a screen that is already gone.
    if (dom['prompter'].hidden) return;

    setPaused(false, true);
    lastAdvanceAt = performance.now(); // don't count the countdown as a stall
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
    measurePace();
    wordTops = wordSpans.map(w => w.offsetTop);
    paintProgress();
}

/**
 * How fast the script should scroll when nothing is pacing it by voice, taken
 * from the script's own length rather than a fixed number of pixels a second.
 * A short script and a long one used to crawl at exactly the same rate.
 */
function measurePace() {
    wordTops = wordSpans.map(w => w.offsetTop);
    const first = wordSpans[0];
    const last = wordSpans[wordSpans.length - 1];
    const height = first && last ? last.offsetTop - first.offsetTop : 0;
    basePxPerSec = naturalPace(height, wordSpans.length, WORDS_PER_MINUTE);
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
        // While a recording owns the microphone, pace on whether a voice is
        // audible instead of scrolling on regardless.
        paused: isPaused || (levelPacing && !readerIsSpeaking()),
        voiceMode: isVoiceMode,
        speed: parseFloat(dom['speed-range'].value),
        wordTop: currentSpan ? currentSpan.offsetTop : null,
        viewportHeight: window.innerHeight,
        basePxPerSec,
        // Stop once the final line has settled around the focus point.
        maxPosition: lastSpan ? lastSpan.offsetTop - window.innerHeight * FOCUS_RATIO : Infinity,
    });

    // Pacing by sound knows nothing about words, but it does know where it has
    // scrolled to. Showing that keeps the highlight meaningful instead of
    // leaving it stuck on a word the reader passed long ago.
    if (levelPacing && wordTops.length) {
        const focusY = scrollPosition + window.innerHeight * FOCUS_RATIO;
        paintCursor(nearestWordIndex(wordTops, focusY));
    }

    dom['script-text'].style.transform = `translate3d(0, ${-scrollPosition}px, 0)`;
    rafHandle = requestAnimationFrame(scrollLoop);
}

/* ---------------------------------------------------------------- voice */

/**
 * A phone cannot be attached to a debugger, and "it does not work" is not
 * something anyone can act on. Every recogniser event is kept here so the
 * actual sequence can be read off the device: whether it ever started, whether
 * it ended immediately, and which error code the browser really gave.
 */
const voiceLog = [];
function logVoice(event) {
    voiceLog.push(`${((performance.now() - voiceLogStart) / 1000).toFixed(1)}s ${event}`);
    if (voiceLog.length > 40) voiceLog.shift();
}

/** Everything needed to tell why voice tracking is not working, as plain text. */
async function buildDiagnostics() {
    const tracks = stream
        ? stream.getTracks().map(t => `${t.kind}:${t.readyState}${t.muted ? ',muted' : ''}`).join(' ')
        : 'no stream';

    let micPermission = 'unknown';
    try {
        micPermission = (await navigator.permissions.query({ name: 'microphone' })).state;
    } catch {
        // Firefox and older Chrome do not expose the microphone permission.
    }

    return [
        `Prompt Me diagnostics`,
        `browser: ${navigator.userAgent}`,
        `speech api: ${window.SpeechRecognition ? 'SpeechRecognition' : ''}${window.webkitSpeechRecognition ? ' webkitSpeechRecognition' : ''} (supported=${isSpeechSupported})`,
        // start(audioTrack) lets the recogniser share the track we already
        // hold, instead of opening a second microphone that Android refuses to
        // grant. Whether this build has it decides whether word tracking can
        // work at all during a recording.
        `pacing: levelPacing=${levelPacing} speaking=${levelDetector.speaking} audioContext=${levelContext ? levelContext.state : 'none'}`,
        `mic permission: ${micPermission}`,
        `online: ${navigator.onLine}`,
        `language: ${dom['lang-select'].value}`,
        `voice: preferred=${voicePreferred} active=${isVoiceMode} heard=${voiceHeard} error=${voiceError || 'none'}`,
        `restarts: ${listener ? listener.restarts : 0}`,
        `tracks: ${tracks}`,
        `recording: ${recorder ? recorder.state : 'inactive'}`,
        ``,
        `events:`,
        ...(voiceLog.length ? voiceLog : ['(none, the recogniser never fired an event)']),
    ].join('\n');
}

async function copyDiagnostics() {
    const report = await buildDiagnostics();
    try {
        await navigator.clipboard.writeText(report);
        dom['diag-btn'].textContent = 'Copied';
    } catch {
        // Clipboard is blocked in some contexts, so show it to be read instead.
        dom['diag-out'].textContent = report;
        dom['diag-out'].hidden = false;
        dom['diag-btn'].textContent = 'Shown below';
    }
    setTimeout(() => { dom['diag-btn'].textContent = 'Copy'; }, 4000);
}

function setupVoice() {
    voiceLogStart = performance.now();
    voiceLog.length = 0;
    listener = new SpeechListener({
        lang: dom['lang-select'].value,
        onEvent: logVoice,
        onResult: ({ finalText, interimText }) => {
            // Counted even while paused: it is the proof that the microphone and
            // the recogniser are alive, which is the first thing to establish
            // when someone reports that voice tracking "does not work".
            voiceHeard += 1;
            lastHeardAt = performance.now();
            if (levelPacing && recorder && recorder.state !== 'inactive') {
                // Recognition is alive after all, so stop gating on loudness and
                // follow the words, which know where in the script we are.
                levelPacing = false;
                showStatus('');
            }
            voiceError = ''; // words are arriving, so any earlier failure is stale
            paintVoiceState();
            paintHearing();
            if (isPaused) return;
            handleTranscript(finalText, interimText);
        },
        onStatus: (state) => {
            // Every state reaches the diagnostics, including the error codes the
            // old handler silently dropped. A microphone that cannot be captured
            // used to look identical to a script that simply was not moving.
            voiceState = state;
            // speech.js passes non-fatal codes through here as "error: <code>".
            // Keep the code, it is the only clue to a microphone that will not
            // open. "aborted" is excluded: it is what the browser reports when
            // WE call abort(), which happens on every pause, so reporting it as
            // a failure blames the app for its own housekeeping.
            if (String(state).startsWith('error:')) {
                const code = String(state).replace('error:', '').trim();
                if (code !== 'aborted') voiceError = code;
            }
            paintVoiceState();
            if (!isVoiceMode) return;
            const friendly = { listening: '', restarting: 'Reconnecting', stopped: '' };
            if (state in friendly) showStatus(friendly[state]);
        },
        onError: (message) => {
            voiceState = 'error';
            voiceError = message;
            paintVoiceState();
            setVoice(false);
            showStatus(`${message} Scrolling at a steady speed instead.`);
        },
    });
}

/**
 * @param {boolean} on
 * @param {boolean} [remember] true only when the user chose this themselves.
 *   Recording pauses voice operationally without this, so the toggle keeps
 *   showing the user's real preference instead of flipping to "Off" for
 *   something the user never asked to change.
 */
function setVoice(on, remember = false) {
    if (on && !isSpeechSupported) return;
    if (remember) {
        voicePreferred = on;
        savePreferences();
    }
    isVoiceMode = on;
    paintVoiceToggle();

    if (on) {
        if (!listener) setupVoice();
        listener.start();
        lastAdvanceAt = performance.now();
        lastHeardAt = performance.now();
        watchForStall();
    } else if (listener) {
        listener.stop();
        clearInterval(stallTimer);
    }
    paintHearing();
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

/** Moves the highlight to a word. Shared by recognition and by sound pacing. */
function paintCursor(cursor) {
    if (cursor < 0 || cursor === lastPaintedCursor) return;

    // Only repaint the span range that changed. Touching every span on each
    // result makes long scripts stutter.
    const from = Math.max(0, Math.min(lastPaintedCursor < 0 ? 0 : lastPaintedCursor, cursor));
    const to = Math.max(lastPaintedCursor, cursor);
    for (let i = from; i <= to && i < wordSpans.length; i++) {
        wordSpans[i].classList.toggle('said', i < cursor);
        wordSpans[i].classList.toggle('current', i === cursor);
    }
    lastPaintedCursor = cursor;
}

function paintProgress() {
    const cursor = matcher ? matcher.cursor : 0;
    if (cursor === lastPaintedCursor) return;

    paintCursor(cursor);
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
        paintHearing();
        if (!isVoiceMode || isPaused || !hasStarted) return;
        if (dom['status'].dataset.stalled) return;
        if (performance.now() - lastAdvanceAt < 8000) return;
        dom['status'].dataset.stalled = '1';
        showStatus(IS_IOS && voiceHeard === 0
            ? 'iPhone browsers cannot run voice tracking. Turn it off in settings and use the speed slider.'
            : 'Not following your voice. Check the language in settings, or switch it off for steady scrolling.');
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

    await acquireMicForRecording();
    recorder = new Recorder(recordStream || stream);
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
    clearTimeout(takeVoiceWatch);
    stopLevelPacing();
    stopVerticalStream();
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
    // A share button that cannot share is worse than no share button.
    dom['share-take'].hidden = !canShareVideo(pendingTake, takeName());
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

function takeName() {
    return `prompt-me-take-${String(currentTake).padStart(2, '0')}-${timestamp()}`;
}

/** Hands the take to the phone's share sheet: Instagram, WhatsApp, Photos. */
async function shareTake() {
    if (!pendingTake) return;
    dom['share-take'].disabled = true;
    dom['review-note'].textContent = 'Opening the share sheet';
    try {
        const result = await shareRecording(pendingTake, takeName());
        if (result.method === 'share') {
            discardTake();
            leaveShoot('Shared. The take is on its way to whichever app you picked.');
            return;
        }
        // Cancelled, unsupported or failed: the take stays exactly where it is.
        dom['review-note'].textContent = result.method === 'unsupported'
            ? 'This browser cannot share files. Use Download instead.'
            : 'Not shared. The take is still here, try again or download it.';
    } finally {
        dom['share-take'].disabled = false;
    }
}

/** Writes the take to the device as a file. */
function saveTake() {
    if (!pendingTake) return;
    dom['review-note'].textContent = 'Saving';
    try {
        downloadRecording(pendingTake, takeName());
        discardTake();
        leaveShoot('Saved to your downloads.');
    } catch {
        dom['review-note'].textContent = 'That did not save. The take is still here, try again.';
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
    paintVoiceToggle();
    paintVoiceState();
}

/** Reflects the user's own choice, not merely the moment-to-moment operational state. */
function paintVoiceToggle() {
    const willListen = isSpeechSupported && voicePreferred;
    dom['voice-toggle'].setAttribute('aria-pressed', String(willListen));
    dom['voice-toggle'].textContent = willListen ? 'On' : 'Off';
}

init();
