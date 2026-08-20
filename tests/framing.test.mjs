import test from 'node:test';
import assert from 'node:assert/strict';
import { coverCrop, verticalSize, VERTICAL_ASPECT } from '../js/framing.js';

test('a landscape camera is cropped at the sides, never letterboxed', () => {
    const { sx, sy, sw, sh } = coverCrop(1920, 1080, 9, 16);
    assert.equal(sh, 1080, 'full sensor height should be kept');
    assert.equal(Math.round(sw), 608);
    assert.equal(sy, 0, 'nothing trimmed vertically');
    assert.ok(sx > 0 && Math.abs(sx - (1920 - sw) / 2) < 0.001, 'crop must be centred');
});

test('a source already taller than 9:16 is trimmed top and bottom', () => {
    const { sx, sy, sw, sh } = coverCrop(1080, 2400, 9, 16);
    assert.equal(sw, 1080, 'full width kept');
    assert.equal(Math.round(sh), 1920);
    assert.equal(sx, 0);
    assert.ok(sy > 0, 'should trim vertically');
});

test('a source already exactly 9:16 is untouched', () => {
    const { sx, sy, sw, sh } = coverCrop(1080, 1920, 9, 16);
    assert.equal(sx, 0);
    assert.equal(sy, 0);
    assert.equal(sw, 1080);
    assert.equal(sh, 1920);
});

test('nonsense dimensions do not produce a nonsense crop', () => {
    assert.deepEqual(coverCrop(0, 0, 9, 16), { sx: 0, sy: 0, sw: 0, sh: 0 });
    assert.deepEqual(coverCrop(1920, 1080, 0, 0), { sx: 0, sy: 0, sw: 1920, sh: 1080 });
});

test('the output is vertical', () => {
    const { width, height } = verticalSize(1920, 1080);
    assert.ok(height > width, `expected a portrait frame, got ${width}x${height}`);
    assert.ok(Math.abs(width / height - VERTICAL_ASPECT) < 0.01);
});

test('a small camera is not upscaled into a bigger, blurrier file', () => {
    // 640x480 crops to 270x480: the output must not claim to be 720x1280.
    const { width, height } = verticalSize(640, 480);
    assert.equal(height, 480);
    assert.equal(width, 270);
});

test('a large camera is capped rather than recorded at full sensor height', () => {
    const { width, height } = verticalSize(3840, 2160);
    assert.equal(height, 1280);
    assert.equal(width, 720);
});

test('dimensions are always even, because H.264 rejects odd ones', () => {
    for (const [w, h] of [[1920, 1080], [1280, 721], [640, 481], [1111, 999], [800, 600]]) {
        const { width, height } = verticalSize(w, h);
        assert.equal(width % 2, 0, `width ${width} is odd for source ${w}x${h}`);
        assert.equal(height % 2, 0, `height ${height} is odd for source ${w}x${h}`);
    }
});

test('a missing source falls back to a sane vertical default', () => {
    assert.deepEqual(verticalSize(0, 0), { width: 720, height: 1280 });
});
