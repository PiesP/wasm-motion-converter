export const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
export const WARN_FILE_SIZE = 100 * 1024 * 1024; // 100MB
export const WARN_FILE_SIZE_HIGH = 200 * 1024 * 1024; // 200MB - suggest low quality
export const WARN_FILE_SIZE_CRITICAL = 300 * 1024 * 1024; // 300MB - suggest scale reduction
export const WARN_RESOLUTION_PIXELS = 1920 * 1080; // 1080p
export const WARN_DURATION_SECONDS = 30; // 30 seconds

export const COMPLEX_CODECS = ['hevc', 'h265', 'vp9', 'av1'];

export const SUPPORTED_VIDEO_MIMES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo',
  'video/x-matroska',
];

export const FFMPEG_CORE_VERSION = '0.12.6';
export const FFMPEG_CORE_URL = `https://unpkg.com/@ffmpeg/core-mt@${FFMPEG_CORE_VERSION}/dist/esm`;

export const QUALITY_PRESETS = {
  gif: {
    low: { fps: 10, colors: 128 },
    medium: { fps: 15, colors: 256 },
    high: { fps: 24, colors: 256 },
  },
  webp: {
    low: { fps: 10, quality: 50, preset: 'picture', compressionLevel: 4 },
    medium: { fps: 15, quality: 75, preset: 'picture', compressionLevel: 4 },
    high: { fps: 24, quality: 90, preset: 'default', compressionLevel: 6 },
  },
} as const;

// Timeout configurations (in milliseconds)
export const TIMEOUT_FFMPEG_INIT = 90_000; // 90 seconds
export const TIMEOUT_FFMPEG_DOWNLOAD = 90_000; // 90 seconds per core asset
export const TIMEOUT_FFMPEG_WORKER_CHECK = 10_000; // 10 seconds for worker isolation check
export const TIMEOUT_VIDEO_ANALYSIS = 30_000; // 30 seconds
export const TIMEOUT_CONVERSION = 300_000; // 5 minutes (300 seconds)
