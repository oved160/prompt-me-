/**
 * Working out which part of the camera frame ends up in the video.
 *
 * Asking the camera for a portrait shape is the obvious approach and the wrong
 * one: a sensor that is natively landscape satisfies it by cropping the middle
 * and scaling up, which zooms hard into the reader's face. So the camera is
 * left at its own aspect and the crop is done here instead, to the same rule
 * the preview uses (CSS object-fit: cover), which is what makes the recording
 * match what the reader framed up.
 */

/** 9:16, the shape every phone-first video platform expects. */
export const VERTICAL_ASPECT = 9 / 16;

/**
 * The largest centred region of a source frame with the destination's aspect.
 *
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @returns {{sx: number, sy: number, sw: number, sh: number}} source rectangle
 */
export function coverCrop(srcW, srcH, dstW, dstH) {
    if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0)) {
        return { sx: 0, sy: 0, sw: srcW || 0, sh: srcH || 0 };
    }

    const srcAspect = srcW / srcH;
    const dstAspect = dstW / dstH;

    if (srcAspect > dstAspect) {
        // Source is wider: keep full height, trim the sides evenly.
        const sw = srcH * dstAspect;
        return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
    }
    // Source is taller: keep full width, trim top and bottom evenly.
    const sh = srcW / dstAspect;
    return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}

/**
 * Output size for a vertical recording taken from this source.
 *
 * Rounded to even numbers because H.264 encoders reject odd dimensions, and
 * capped so a small source is not upscaled into a bigger, blurrier file than
 * the camera can actually justify.
 *
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} [maxHeight]
 */
export function verticalSize(srcW, srcH, maxHeight = 1280) {
    if (!(srcW > 0 && srcH > 0)) return { width: 720, height: 1280 };

    const crop = coverCrop(srcW, srcH, VERTICAL_ASPECT, 1);
    // Never invent detail: the tallest honest output is the crop's own height.
    const height = Math.min(maxHeight, Math.round(crop.sh));
    const width = Math.round(height * VERTICAL_ASPECT);
    return { width: even(width), height: even(height) };
}

function even(n) {
    const rounded = Math.max(2, Math.round(n));
    return rounded % 2 === 0 ? rounded : rounded + 1;
}
