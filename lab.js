/**
 * A deliberately dumb harness. It calls the two APIs directly, logs every
 * lifecycle event with a timestamp, and never second-guesses anything: no
 * watchdogs, no restarts, no fallbacks. The app's own machinery aborts and
 * restarts recognition on several timers, which makes it impossible to tell a
 * platform failure from the app reacting to one. Nothing here calls stop() or
 * abort() except at the very end of a test, and it says so in the log when it does.
 */
const logEl = document.getElementById('log');
const verdictEl = document.getElementById('verdict');
const buttons = ['a', 'b', 'c', 'd'].map((id) => document.getElementById(id));

let t0 = 0;
let lines = [];

function log(msg) {
    const t = ((performance.now() - t0) / 1000).toFixed(2).padStart(6, ' ');
    lines.push(`${t}s  ${msg}`);
    logEl.textContent = lines.join('\n');
    logEl.scrollTop = logEl.scrollHeight;
}

function trackReport(stream, label) {
    if (!stream) return log(`${label}: no stream`);
    for (const t of stream.getTracks()) {
        log(`${label} track ${t.kind}: readyState=${t.readyState} enabled=${t.enabled} muted=${t.muted}`);
    }
}

function header(name) {
    lines = [];
    t0 = performance.now();
    log(`=== ${name} ===`);
    log(`ua: ${navigator.userAgent}`);
    log(`lang: ${document.getElementById('lang').value}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wires a recogniser and logs every single thing it does. Never restarts it. */
function makeRecogniser({ audioTrack = null } = {}) {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) { log('SpeechRecognition: NOT AVAILABLE'); return null; }

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = document.getElementById('lang').value;

    const state = { results: 0, errors: [], ended: false, started: false };

    rec.onstart = () => { state.started = true; log('SR onstart'); };
    rec.onaudiostart = () => log('SR onaudiostart');
    rec.onsoundstart = () => log('SR onsoundstart');
    rec.onspeechstart = () => log('SR onspeechstart');
    rec.onspeechend = () => log('SR onspeechend');
    rec.onsoundend = () => log('SR onsoundend');
    rec.onaudioend = () => log('SR onaudioend');
    rec.onerror = (e) => { state.errors.push(e.error); log(`SR onerror: ${e.error}`); };
    rec.onend = () => { state.ended = true; log('SR onend'); };
    rec.onresult = (e) => {
        state.results += 1;
        let text = '';
        for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
        log(`SR onresult #${state.results}: "${text.slice(0, 50)}"`);
    };

    try {
        if (audioTrack) {
            log(`SR start(audioTrack) kind=${audioTrack.kind} readyState=${audioTrack.readyState}`);
            rec.start(audioTrack);
        } else {
            log('SR start()  [own microphone]');
            rec.start();
        }
    } catch (err) {
        log(`SR start() THREW: ${err.name} ${err.message}`);
    }
    return { rec, state };
}

function makeRecorder(stream) {
    const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
                   'video/webm;codecs=vp9,opus', 'video/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    log(`MediaRecorder mimeType: ${mimeType || 'NONE SUPPORTED'}`);

    const state = { chunks: 0, bytes: 0, errors: [] };
    const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mr.ondataavailable = (e) => {
        if (e.data && e.data.size) { state.chunks += 1; state.bytes += e.data.size; }
    };
    mr.onerror = (e) => { state.errors.push(String(e.error || e)); log(`MR onerror: ${e.error}`); };
    mr.onstart = () => log('MR onstart');
    mr.onstop = () => log('MR onstop');

    log('MR start(1000)');
    mr.start(1000);
    return { mr, state };
}

async function runTest(name, fn) {
    buttons.forEach((b) => { b.disabled = true; });
    verdictEl.textContent = `${name} running — talk continuously for 15 seconds…`;
    header(name);
    let verdict = '';
    try {
        verdict = await fn();
    } catch (err) {
        log(`TEST THREW: ${err.name} ${err.message}`);
        verdict = `${name}: threw ${err.name}`;
    }
    log('=== end ===');
    verdictEl.textContent = verdict;
    buttons.forEach((b) => { b.disabled = false; });
}

/** TEST A — recognition on its own. The known-working baseline. */
document.getElementById('a').onclick = () => runTest('TEST A: recognition only', async () => {
    const r = makeRecogniser();
    if (!r) return 'A: no SpeechRecognition in this browser';
    await sleep(15000);
    log('calling SR.stop()  [end of test, deliberate]');
    r.rec.stop();
    await sleep(500);
    return `A: results=${r.state.results}  errors=[${r.state.errors}]\n` +
           (r.state.results > 0 ? 'Recognition works with no recorder present.'
                                : 'Recognition produced NOTHING even alone.');
});

/** TEST B — recorder on its own. Confirms recording is healthy by itself. */
document.getElementById('b').onclick = () => runTest('TEST B: recorder only', async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' }, audio: true,
    });
    document.getElementById('preview').srcObject = stream;
    trackReport(stream, 'gUM');
    const rr = makeRecorder(stream);
    await sleep(15000);
    log('calling MR.stop()  [end of test, deliberate]');
    rr.mr.stop();
    await sleep(500);
    trackReport(stream, 'gUM after');
    stream.getTracks().forEach((t) => t.stop());
    return `B: chunks=${rr.state.chunks} bytes=${rr.state.bytes} errors=[${rr.state.errors}]\n` +
           (rr.state.bytes > 0 ? 'Recording works on its own.' : 'Recording captured NOTHING.');
});

/** TEST C — both at once, recogniser opening its own microphone. The key case. */
document.getElementById('c').onclick = () => runTest('TEST C: recorder + recognition (own mic)', async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' }, audio: true,
    });
    document.getElementById('preview').srcObject = stream;
    trackReport(stream, 'gUM');
    const rr = makeRecorder(stream);
    await sleep(600); // let the recorder settle before recognition asks for the mic
    const r = makeRecogniser();
    if (!r) return 'C: no SpeechRecognition in this browser';

    await sleep(14000);
    trackReport(stream, 'gUM during');
    log('calling SR.stop() and MR.stop()  [end of test, deliberate]');
    r.rec.stop();
    rr.mr.stop();
    await sleep(500);
    stream.getTracks().forEach((t) => t.stop());
    return `C: SR results=${r.state.results} errors=[${r.state.errors}] | ` +
           `MR chunks=${rr.state.chunks} bytes=${rr.state.bytes}\n` +
           (r.state.results > 0
               ? 'Both run together. The failure is in our app, not the platform.'
               : 'Recognition produced nothing while recording. Platform conflict confirmed.');
});

/** TEST D — same as C, but handing the recogniser the recorder's own track. */
document.getElementById('d').onclick = () => runTest('TEST D: recorder + recognition (shared track)', async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' }, audio: true,
    });
    document.getElementById('preview').srcObject = stream;
    trackReport(stream, 'gUM');
    const rr = makeRecorder(stream);
    await sleep(600);
    const r = makeRecogniser({ audioTrack: stream.getAudioTracks()[0] });
    if (!r) return 'D: no SpeechRecognition in this browser';

    await sleep(14000);
    log('calling SR.stop() and MR.stop()  [end of test, deliberate]');
    r.rec.stop();
    rr.mr.stop();
    await sleep(500);
    stream.getTracks().forEach((t) => t.stop());
    return `D: SR results=${r.state.results} errors=[${r.state.errors}] | ` +
           `MR chunks=${rr.state.chunks} bytes=${rr.state.bytes}\n` +
           (r.state.results > 0
               ? 'The shared track works. Wire the app to this.'
               : 'Shared track made no difference on this device.');
});

document.getElementById('copy').onclick = async () => {
    try {
        await navigator.clipboard.writeText(lines.join('\n'));
        document.getElementById('copy').textContent = 'Copied';
        setTimeout(() => { document.getElementById('copy').textContent = 'Copy log'; }, 2500);
    } catch {
        document.getElementById('copy').textContent = 'Select the log below and copy';
    }
};
