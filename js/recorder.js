export function pickMimeType() {
  // MP4 is preferred because Android and iOS photo galleries typically 
  // do not import .webm files natively.
  const types = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];

  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

export class Recorder {
  constructor(stream) {
    this.stream = stream;
    this.recorder = null;
    this.chunks = [];
    this.startTime = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.mimeType = '';
    this.stopPromiseResolver = null;
  }

  get state() {
    if (!this.recorder) return 'inactive';
    if (this.recorder.state === 'recording') return 'recording';
    if (this.recorder.state === 'paused') return 'paused';
    return 'inactive';
  }

  /** Wall time minus every stretch spent paused, so the clock matches the file. */
  get elapsedMs() {
    if (this.state === 'inactive') return 0;
    const pausedNow = this.pausedAt ? performance.now() - this.pausedAt : 0;
    return performance.now() - this.startTime - this.pausedTotal - pausedNow;
  }

  pause() {
    if (this.state !== 'recording') return;
    this.recorder.pause();
    this.pausedAt = performance.now();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.pausedTotal += performance.now() - this.pausedAt;
    this.pausedAt = 0;
    this.recorder.resume();
  }

  start() {
    this.mimeType = pickMimeType();
    if (!this.mimeType) {
      throw new Error('No supported video mime type found for this browser.');
    }

    this.chunks = [];
    // MediaRecorder defaults to roughly 2.5 Mbps, which looks soft and blocky
    // at 1080p. Ask for a bitrate that matches what the camera is capturing.
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 128_000,
    });

    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data);
      }
    };

    this.recorder.onstop = () => {
      if (this.stopPromiseResolver) {
        const blob = new Blob(this.chunks, { type: this.mimeType });
        this.stopPromiseResolver(blob);
        this.stopPromiseResolver = null;
      }
    };

    // If the recorder dies mid-take, resolve with whatever was captured rather
    // than leaving stop() pending forever and freezing the record button.
    this.recorder.onerror = () => {
      if (this.stopPromiseResolver) {
        this.stopPromiseResolver(this.chunks.length ? new Blob(this.chunks, { type: this.mimeType }) : null);
        this.stopPromiseResolver = null;
      }
    };

    this.startTime = performance.now();
    this.pausedAt = 0;
    this.pausedTotal = 0;
    // Flush data every second to prevent loss of long recordings in a single buffer
    this.recorder.start(1000);
  }

  stop() {
    if (this.state === 'inactive') {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      this.stopPromiseResolver = resolve;
      // A recorder that never fires onstop would hang the UI with no way back.
      const bail = setTimeout(() => {
        if (this.stopPromiseResolver) {
          this.stopPromiseResolver(this.chunks.length ? new Blob(this.chunks, { type: this.mimeType }) : null);
          this.stopPromiseResolver = null;
        }
      }, 5000);
      const settle = this.stopPromiseResolver;
      this.stopPromiseResolver = (blob) => { clearTimeout(bail); settle(blob); };
      this.recorder.stop();
    });
  }
}

/**
 * The file a take should be saved or shared as.
 *
 * The type is stripped back to bare "video/mp4". MediaRecorder reports the full
 * string it recorded with, codecs and all, and passing that straight into a
 * File gives it a type of "video/mp4;codecs=avc1.42E01E,mp4a.40.2". Android
 * share targets match on the exact MIME type, and nothing matches that, so the
 * share sheet comes up with nothing in it or does nothing at all. canShare()
 * still answers true, which is what makes it look like it ought to work.
 */
export function takeFile(blob, filenameBase) {
  const baseType = (blob.type || '').split(';')[0] || 'video/mp4';
  const extension = baseType.includes('mp4') ? '.mp4' : '.webm';
  return new File([blob], `${filenameBase}${extension}`, { type: baseType });
}

/** Whether this device can hand a video to other apps at all. */
export function canShareVideo(blob, filenameBase = 'take') {
  if (!navigator.canShare) return false;
  try {
    return navigator.canShare({ files: [takeFile(blob, filenameBase)] });
  } catch {
    return false;
  }
}

/**
 * Hands the take to the phone's own share sheet, which is what puts it into
 * Instagram, WhatsApp, TikTok or Photos. Sharing and downloading are separate
 * on purpose: one button that silently did whichever the device supported gave
 * people no way to ask for the other.
 */
export async function shareRecording(blob, filenameBase) {
  const file = takeFile(blob, filenameBase);
  if (!canShareVideo(blob, filenameBase)) return { method: 'unsupported' };
  try {
    await navigator.share({ files: [file], title: filenameBase });
    return { method: 'share' };
  } catch (err) {
    if (err.name === 'AbortError') return { method: 'cancelled' };
    return { method: 'failed' };
  }
}

/** Writes the take straight to the device as a file. */
export function downloadRecording(blob, filenameBase) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = takeFile(blob, filenameBase).name;
  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);

  return { method: 'download' };
}

