import type tyVideoMetadataadata } fr.otypes/conversionttypesnversion-types';
import peffmpegServiceom './ffmegffmpegservice

export function analyzeVideo(file: File): Promise<VideoMetadata> {
  return ffmpegService.getVideoMetadata(file);
}

export function analyzeVideoQuick(file: File): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Video metadata loading timed out'));
    }, 5000);

    const cleanup = () => {
      clearTimeout(timeoutId);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };

    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      let detectedCodec = 'unknown';

      // Try using canPlayType with common codecs for better detection
      // This helps identify codec for formats like AV1, VP9, H.265, etc.
      const codecsToCheck = [
        // AV1 variants
        { codec: 'av01.0.08M.08', name: 'AV1' },
        { codec: 'av01.0.08H.08', name: 'AV1' },
        // H.265/HEVC
        { codec: 'hev1.1.2.L93.B0', name: 'H.265' },
        { codec: 'hev1.1.2.L120.B0', name: 'H.265' },
        { codec: 'hvc1.1.2.L120.B0', name: 'H.265' },
        // VP9
        { codec: 'vp09.00.10.08', name: 'VP9' },
        { codec: 'vp09.00.50.08', name: 'VP9' },
        // H.264
        { codec: 'avc1.4d401f', name: 'H.264' },
        { codec: 'avc1.42E01E', name: 'H.264' },
        { codec: 'avc1.640029', name: 'H.264' },
        // VP8
        { codec: 'vp8', name: 'VP8' },
      ];

      for (const { codec, name } of codecsToCheck) {
        const mimeType = `video/mp4;codecs="${codec}"`;
        const canPlay = video.canPlayType(mimeType);
        if (canPlay === 'probably' || canPlay === 'maybe') {
          detectedCodec = name;
          break;
        }
      }

      const metadata: VideoMetadata = {
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        codec: detectedCodec,
        framerate: 0,
        bitrate: 0,
      };
      cleanup();
      resolve(metadata);
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('Failed to load video metadata'));
    };

    video.src = url;
  });
}
