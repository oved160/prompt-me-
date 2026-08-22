/**
 * Runs the synthetic load off the main thread, which is where any real
 * inference would have to live.
 *
 * The duty cycle is expressed as work per 200ms window rather than as a flat
 * busy loop, because that is the shape inference actually has: a burst per
 * audio chunk, then idle until the next one. A flat loop would answer a
 * question nobody is asking.
 */
import { createLoad, FLOPS_PER_ITERATION } from './bench-load.js';

const PERIOD_MS = 200;
const load = createLoad();

let timer = null;
let onMs = 0;
let iterations = 0;
let busyMs = 0;

function tick() {
    if (onMs <= 0) return;
    const started = performance.now();
    iterations += load.burn(onMs);
    busyMs += performance.now() - started;
}

self.onmessage = (e) => {
    const { type, duty } = e.data;

    if (type === 'start') {
        clearInterval(timer);
        onMs = Math.round(PERIOD_MS * duty);
        iterations = 0;
        busyMs = 0;
        // At 100% duty the burn fills the whole period, so the interval simply
        // fires back to back. No special case needed.
        timer = setInterval(tick, PERIOD_MS);
        self.postMessage({ type: 'started', onMs, periodMs: PERIOD_MS });
        return;
    }

    if (type === 'sample') {
        // Reported and reset each second, so the main thread gets a per-second
        // throughput series rather than one number at the end. A worker that
        // slows down over 90 seconds is itself evidence of throttling.
        const gflops = (iterations * FLOPS_PER_ITERATION) / 1e9;
        self.postMessage({ type: 'sample', iterations, busyMs, gflops });
        iterations = 0;
        busyMs = 0;
        return;
    }

    if (type === 'stop') {
        clearInterval(timer);
        timer = null;
        onMs = 0;
        self.postMessage({ type: 'stopped', checksum: load.checksum });
    }
};
