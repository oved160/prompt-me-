/**
 * The synthetic compute load for TEST E.
 *
 * A dense float matmul, chosen because it is the one thing every neural network
 * inference engine spends nearly all its time doing. It is emphatically NOT an
 * ONNX Runtime kernel: no SIMD intrinsics, no cache-blocking, no thread pool.
 * Real kernels are several times faster per unit of work, which means a duty
 * cycle measured here BUYS MORE real inference than it looks like it does.
 *
 * That direction matters. This test is conservative: when it says the phone has
 * no headroom, believe it. When it says there is headroom, treat that as an
 * upper bound to be confirmed against a real model, never as a promise.
 *
 * Shared by the worker and by the main-thread control run so both burn
 * identical work. One copy, so the comparison between them means something.
 */

const N = 64; // 64x64x64 = 262k multiply-adds per call: big enough not to be elided

/** A burner with its own buffers, so two of these never share memory. */
export function createLoad() {
    const a = new Float32Array(N * N);
    const b = new Float32Array(N * N);
    const c = new Float32Array(N * N);

    // Seeded rather than random: every run does bit-identical work, so a slower
    // run is the phone being slower, not the data being different.
    for (let i = 0; i < a.length; i++) {
        a[i] = ((i * 2654435761) % 1000) / 1000;
        b[i] = ((i * 40503) % 1000) / 1000;
    }

    let sink = 0;

    function multiplyOnce() {
        for (let i = 0; i < N; i++) {
            const aRow = i * N;
            for (let k = 0; k < N; k++) {
                const av = a[aRow + k];
                if (av === 0) continue;
                const bRow = k * N;
                for (let j = 0; j < N; j++) c[aRow + j] += av * b[bRow + j];
            }
        }
        // Consume the result. Without this a clever JIT is free to notice that
        // nothing reads c and delete the entire loop, and we would be measuring
        // an empty room.
        sink += c[(sink | 0) % c.length];
        return sink;
    }

    return {
        /** Burn approximately `ms` milliseconds. Returns iterations completed. */
        burn(ms) {
            const deadline = performance.now() + ms;
            let iterations = 0;
            // Always at least one: a zero-length budget should still do nothing
            // rather than spin the clock check forever.
            do {
                multiplyOnce();
                iterations++;
            } while (performance.now() < deadline);
            return iterations;
        },
        get checksum() { return sink; },
    };
}

/** Work per burn call, for turning iteration counts into a throughput number. */
export const FLOPS_PER_ITERATION = 2 * N * N * N;
