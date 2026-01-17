/**
 * MP4 Smoke Test (Dev Only)
 *
 * Provides a small end-to-end harness to validate MP4 output in real browsers.
 *
 * What it tests:
 * - WebCodecs decode path (via WebCodecsDecoderService → RGBA frames)
 * - MP4 encoding + muxing (via EncoderFactory → mp4-webcodecs adapter)
 * - Playback sanity (HTMLVideoElement loadedmetadata/canplay)
 * - Download behavior (optional)
 *
 * Notes:
 * - This module must only be used in dev mode.
 * - It intentionally does not integrate with the production UI.
 */

import { EncoderFactory } from '@services/encoders/encoder-factory-service';
import type { WebCodecsCaptureMode } from '@services/webcodecs/decoder/types-service';
import { waitForEvent } from '@services/webcodecs/decoder/wait-for-event-service';
import { WebCodecsDecoderService } from '@services/webcodecs-decoder-service';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

const DEFAULT_FILE_ACCEPT = 'video/*';
const DEFAULT_TARGET_FPS = 24;
const DEFAULT_SCALE = 1;
const DEFAULT_MAX_FRAMES = 120;
const DEFAULT_CAPTURE_MODE: WebCodecsCaptureMode = 'auto';
const DEFAULT_QUALITY = 'medium';
const DEFAULT_PLAYBACK_TIMEOUT_MS = 6_000;
const DOWNLOAD_REVOKE_DELAY_MS = 3_000;
const PLAYBACK_CANPLAY_TIMEOUT_MS = 1_200;
const DEFAULT_PREVIEW_CONTAINER_ID = 'dropconvert-dev-mp4-smoke-test';
const DEFAULT_PREVIEW_TITLE = 'MP4 Smoke Test (dev)';

export type Mp4SmokeTestOptions = {
  /** Target frames per second for extraction. */
  targetFps?: number;
  /** Scale factor applied during extraction (1 = original). */
  scale?: number;
  /** Limit the total extracted frames to keep the run small. */
  maxFrames?: number;
  /** Capture mode override (defaults to auto). */
  captureMode?: WebCodecsCaptureMode;
  /** Encoder quality (maps to bitrate policy in adapter). */
  quality?: 'low' | 'medium' | 'high';

  /** Validate the resulting MP4 can be loaded by <video>. */
  validatePlayback?: boolean;
  /** Append a preview <video> element to the page. */
  mountPreview?: boolean;
  /** Trigger a browser download for the output MP4. */
  autoDownload?: boolean;

  /** Filename used when autoDownload is enabled. */
  filename?: string;
  /** Timeout for playback validation. */
  playbackTimeoutMs?: number;
};

export type Mp4SmokeTestPlaybackResult = {
  ok: boolean;
  durationSeconds: number;
  videoWidth: number;
  videoHeight: number;
  error?: string;
};

export type Mp4SmokeTestResult = {
  blob: Blob;
  url: string;
  decoded: {
    frameCount: number;
    width: number;
    height: number;
    fps: number;
    durationSeconds: number;
    captureModeUsed?: WebCodecsCaptureMode;
  };
  encoder: {
    name: string;
  };
  playback?: Mp4SmokeTestPlaybackResult;
};

export async function pickVideoFile(accept = DEFAULT_FILE_ACCEPT): Promise<File> {
  if (typeof document === 'undefined') {
    throw new Error('pickVideoFile() requires a browser DOM.');
  }

  return new Promise<File>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = false;
    input.style.position = 'fixed';
    input.style.left = '-9999px';

    const cleanup = (): void => {
      input.value = '';
      input.remove();
    };

    const handleChange = (): void => {
      try {
        const file = input.files?.item(0) ?? null;
        if (!file) {
          reject(new Error('No file selected.'));
          return;
        }
        resolve(file);
      } finally {
        cleanup();
      }
    };

    input.addEventListener('change', handleChange, { once: true });

    document.body.appendChild(input);
    input.click();
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === 'undefined') {
    throw new Error('downloadBlob() requires a browser DOM.');
  }

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Keep the URL alive briefly so the browser can start the download.
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);
  }
}

export function mountVideoPreview(url: string): HTMLVideoElement {
  if (typeof document === 'undefined') {
    throw new Error('mountVideoPreview() requires a browser DOM.');
  }

  const video = document.createElement('video');
  video.controls = true;
  video.muted = true;
  video.playsInline = true;
  video.style.maxWidth = 'min(720px, 100%)';
  video.style.display = 'block';
  video.style.margin = '12px 0';
  video.src = url;

  const containerId = DEFAULT_PREVIEW_CONTAINER_ID;
  let container = document.getElementById(containerId);
  if (!container) {
    container = document.createElement('div');
    container.id = containerId;
    container.style.position = 'fixed';
    container.style.right = '12px';
    container.style.bottom = '12px';
    container.style.zIndex = '9999';
    container.style.padding = '12px';
    container.style.borderRadius = '12px';
    container.style.background = 'rgba(0,0,0,0.65)';
    container.style.backdropFilter = 'blur(6px)';
    container.style.color = '#fff';
    container.style.maxWidth = '760px';
    container.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif';

    const title = document.createElement('div');
    title.textContent = DEFAULT_PREVIEW_TITLE;
    title.style.fontWeight = '600';
    title.style.marginBottom = '8px';

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.style.marginLeft = '12px';
    close.style.padding = '4px 8px';
    close.style.borderRadius = '8px';
    close.style.border = '1px solid rgba(255,255,255,0.3)';
    close.style.background = 'transparent';
    close.style.color = '#fff';
    close.addEventListener('click', () => container?.remove());

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.appendChild(title);
    header.appendChild(close);

    container.appendChild(header);
    document.body.appendChild(container);
  }

  container.appendChild(video);
  return video;
}

export async function validateMp4Playback(
  blob: Blob,
  timeoutMs = 6_000
): Promise<Mp4SmokeTestPlaybackResult> {
  if (typeof document === 'undefined') {
    throw new Error('validateMp4Playback() requires a browser DOM.');
  }

  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = url;

  // Keep the element in-DOM but non-intrusive to reduce throttling.
  video.style.position = 'fixed';
  video.style.right = '0';
  video.style.bottom = '0';
  video.style.width = '2px';
  video.style.height = '2px';
  video.style.opacity = '0.001';

  document.body.appendChild(video);

  try {
    await waitForEvent(video, 'loadedmetadata', timeoutMs);

    // Attempt to advance the pipeline. This may be blocked by autoplay policies.
    // Treat play() failures as non-fatal if metadata looks sane.
    try {
      await video.play();
    } catch {
      // ignore
    }

    // If it can reach canplay quickly, it's a stronger signal.
    try {
      await waitForEvent(video, 'canplay', PLAYBACK_CANPLAY_TIMEOUT_MS);
    } catch {
      // ignore
    }

    const durationSeconds = Number.isFinite(video.duration) ? video.duration : 0;
    const videoWidth = video.videoWidth || 0;
    const videoHeight = video.videoHeight || 0;

    const ok = durationSeconds > 0 && videoWidth > 0 && videoHeight > 0;

    return {
      ok,
      durationSeconds,
      videoWidth,
      videoHeight,
      error: ok ? undefined : 'Video metadata did not load correctly (duration/size is 0).',
    };
  } catch (error) {
    return {
      ok: false,
      durationSeconds: 0,
      videoWidth: 0,
      videoHeight: 0,
      error: getErrorMessage(error),
    };
  } finally {
    try {
      video.pause();
    } catch {
      // ignore
    }
    video.remove();
    URL.revokeObjectURL(url);
  }
}

export async function runMp4SmokeTest(params?: {
  file?: File;
  options?: Mp4SmokeTestOptions;
}): Promise<Mp4SmokeTestResult> {
  if (!import.meta.env.DEV) {
    throw new Error('MP4 smoke test is dev-only.');
  }

  const file = params?.file ?? (await pickVideoFile());
  const options = params?.options ?? {};

  const targetFps = options.targetFps ?? DEFAULT_TARGET_FPS;
  const scale = options.scale ?? DEFAULT_SCALE;
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  const captureMode = options.captureMode ?? DEFAULT_CAPTURE_MODE;
  const quality = options.quality ?? DEFAULT_QUALITY;

  logger.info('mp4-encoder', 'Starting MP4 smoke test', {
    fileName: file.name,
    fileSizeBytes: file.size,
    targetFps,
    scale,
    maxFrames,
    captureMode,
    quality,
  });

  const decoder = new WebCodecsDecoderService();
  const frames: ImageData[] = [];

  const decodeResult = await decoder.decodeToFrames({
    file,
    targetFps,
    scale,
    frameFormat: 'rgba',
    frameQuality: 0.95,
    framePrefix: 'smoke_',
    frameDigits: 6,
    frameStartNumber: 0,
    maxFrames,
    captureMode,
    codec: undefined,
    quality,
    onFrame: async (frame) => {
      if (!frame.imageData) {
        throw new Error('Smoke test expected RGBA frames (ImageData), but got none.');
      }
      frames.push(frame.imageData);
    },
  });

  if (frames.length === 0) {
    throw new Error('Smoke test decode produced zero frames.');
  }

  const encoder = await EncoderFactory.getEncoder('mp4', {
    preferWorkers: false,
    quality,
  });

  if (!encoder) {
    throw new Error(
      'No MP4 encoder is available (EncoderFactory.getEncoder("mp4") returned null).'
    );
  }

  logger.info('mp4-encoder', 'Encoding frames to MP4', {
    encoder: encoder.name,
    frameCount: frames.length,
    width: decodeResult.width,
    height: decodeResult.height,
    fps: decodeResult.fps,
  });

  const blob = await encoder.encode({
    frames,
    width: decodeResult.width,
    height: decodeResult.height,
    fps: decodeResult.fps,
    quality,
    onProgress: (current, total) => {
      if (current === 1 || current === total || current % 30 === 0) {
        logger.debug('mp4-encoder', 'MP4 encode progress', {
          current,
          total,
        });
      }
    },
  });

  const url = URL.createObjectURL(blob);

  const playbackTimeoutMs = options.playbackTimeoutMs ?? DEFAULT_PLAYBACK_TIMEOUT_MS;
  const shouldValidatePlayback = options.validatePlayback !== false;

  const playback = shouldValidatePlayback
    ? await validateMp4Playback(blob, playbackTimeoutMs)
    : undefined;

  if (options.mountPreview) {
    mountVideoPreview(url);
  }

  if (options.autoDownload) {
    const filename = options.filename ?? `${file.name.replace(/\.[^.]+$/, '')}.mp4`;
    downloadBlob(blob, filename);
  }

  logger.info('mp4-encoder', 'MP4 smoke test completed', {
    outputSizeBytes: blob.size,
    playbackOk: playback?.ok ?? null,
    playbackDurationSeconds: playback?.durationSeconds ?? null,
    playbackWidth: playback?.videoWidth ?? null,
    playbackHeight: playback?.videoHeight ?? null,
  });

  return {
    blob,
    url,
    decoded: {
      frameCount: frames.length,
      width: decodeResult.width,
      height: decodeResult.height,
      fps: decodeResult.fps,
      durationSeconds: decodeResult.duration,
      captureModeUsed: decodeResult.captureModeUsed,
    },
    encoder: {
      name: encoder.name,
    },
    playback,
  };
}

export function revokeObjectUrl(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    // ignore
  }
}
