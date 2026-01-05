export const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
export const WARN_FILE_SIZE = 100 * 1024 * 1024; // 100MB
export const WARN_FILE_SIZE_HIGH = 200 * 1024 * 1024; // 200MB - suggest low quality
export const WARN_FILE_SIZE_CRITICAL = 300 * 1024 * 1024; // 300MB - suggest scale reduction
export const WARN_RESOLUTION_PIXELS = 1920 * 1080; // 1080p
export const WARN_DURATION_SECONDS = 30; // 30 seconds

export const COMPLEX_CODECS = ['hevc', 'h265', 'hvc1', 'hev1', 'vp9', 'vp09', 'av1', 'av01'];

export const WEBCODECS_ACCELERATED = [
  'av1',
  'av01',
  'hevc',
  'h265',
  'hvc1',
  'hev1',
  'vp9',
  'vp09',
  'vp8',
  'vp08',
  'h264',
  'avc1',
  'avc3',
];

export const SUPPORTED_VIDEO_MIMES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo',
  'video/x-matroska',
  'video/x-m4v',
  'video/ogg',
  'video/mpeg',
  'video/mp2t',
  'video/x-ms-wmv',
  'video/x-flv',
];

export const SUPPORTED_VIDEO_EXTENSIONS = [
  'mp4',
  'mov',
  'webm',
  'avi',
  'mkv',
  'm4v',
  'ogv',
  'mpg',
  'mpeg',
  'ts',
  'mts',
  'm2ts',
  'wmv',
  'flv',
];

export const FFMPEG_CORE_VERSION = '0.12.6';
export const FFMPEG_CORE_BASE_URLS = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@${FFMPEG_CORE_VERSION}/dist/esm`,
  `https://unpkg.com/@ffmpeg/core-mt@${FFMPEG_CORE_VERSION}/dist/esm`,
];

// Note: GIF palettegen filter's stats_mode parameter is not supported in ffmpeg.wasm 5.1.4
// and has been removed. FFmpeg uses its default statistics mode which works correctly.
export const QUALITY_PRESETS = {
  gif: {
    low: { fps: 10, colors: 128 },
    medium: { fps: 15, colors: 256 },
    high: { fps: 24, colors: 256 },
  },
  webp: {
    low: { fps: 10, quality: 70, preset: 'default', compressionLevel: 3, method: 4 },
    medium: { fps: 15, quality: 85, preset: 'default', compressionLevel: 4, method: 5 },
    high: { fps: 24, quality: 95, preset: 'default', compressionLevel: 6, method: 6 },
  },
  avif: {
    low: { quality: 60, speed: 8 },
    medium: { quality: 70, speed: 6 },
    high: { quality: 80, speed: 4 },
  },
} as const;

// Timeout configurations (in milliseconds)
export const TIMEOUT_FFMPEG_INIT = 90_000; // 90 seconds
export const TIMEOUT_FFMPEG_DOWNLOAD = 90_000; // 90 seconds per core asset
export const TIMEOUT_FFMPEG_WORKER_CHECK = 10_000; // 10 seconds for worker isolation check
export const TIMEOUT_VIDEO_ANALYSIS = 30_000; // 30 seconds
export const TIMEOUT_CONVERSION = 60_000; // 60 seconds (reduced from 5min due to WebP libwebp hang issues)
