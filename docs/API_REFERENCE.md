# API Reference

This document provides detailed API documentation for the core services, types, and utilities in dropconvert-wasm.

---

## Table of Contents

1. [Conversion Service](#conversion-service)
2. [FFmpeg Service](#ffmpeg-service)
3. [WebCodecs Services](#webcodecs-services)
4. [Video Analysis](#video-analysis)
5. [Types](#types)
6. [Utilities](#utilities)
7. [Stores](#stores)

---

## Conversion Service

**File**: `src/services/conversion-service.ts`

### `convertVideo()`

Main entry point for video conversion with codec-aware path selection.

```typescript
async function convertVideo(
  file: File,
  options: ConversionOptions,
  onProgress?: ConversionProgressCallback
): Promise<Blob>
```

**Parameters:**
- `file`: Video file to convert (File object)
- `options`: Conversion settings (format, quality, scale)
- `onProgress`: Optional callback for progress updates

**Returns**: Promise<Blob> - Converted video as blob

**Throws**: Error with classification (network, unsupported-format, memory, timeout, unknown)

**Example:**
```typescript
import { convertVideo } from './services/conversion-service';

const blob = await convertVideo(
  videoFile,
  { format: 'gif', quality: 'high', scale: '1' },
  (progress, message) => {
    console.log(`${progress}%: ${message}`);
  }
);
```

**Behavior:**
1. Validates input file
2. Analyzes video metadata
3. Checks memory availability
4. Selects optimal conversion path (WebCodecs vs FFmpeg)
5. Executes conversion with progress tracking
6. Returns output blob or throws classified error

---

## FFmpeg Service

**File**: `src/services/ffmpeg-service.ts`

### `ffmpegService.convertToGIF()`

Convert video to GIF using FFmpeg.

```typescript
async function convertToGIF(
  file: File,
  options: ConversionOptions,
  onProgress?: ConversionProgressCallback
): Promise<Blob>
```

**Parameters:**
- `file`: Input video file
- `options`: Conversion settings (quality, scale)
- `onProgress`: Progress callback (0-100)

**Returns**: Promise<Blob> - GIF blob

**FFmpeg Command Generated:**
```bash
ffmpeg -i input.mp4 \
  -vf "fps=10,scale=640:-1:flags=lanczos" \
  -c:v gif \
  -f gif \
  output.gif
```

### `ffmpegService.convertToWebP()`

Convert video to animated WebP using FFmpeg.

```typescript
async function convertToWebP(
  file: File,
  options: ConversionOptions,
  onProgress?: ConversionProgressCallback
): Promise<Blob>
```

**Returns**: Promise<Blob> - WebP blob

**FFmpeg Command Generated:**
```bash
ffmpeg -i input.mp4 \
  -vf "fps=15,scale=640:-1" \
  -c:v libwebp \
  -lossless 0 \
  -quality 75 \
  -f webp \
  output.webp
```

### `ffmpegService.getVideoMetadata()`

Extract video metadata using FFmpeg.

```typescript
async function getVideoMetadata(file: File): Promise<VideoMetadata>
```

**Returns**: Promise<VideoMetadata> - Metadata object with:
- `duration`: Duration in seconds
- `width`: Video width
- `height`: Video height
- `framerate`: FPS
- `codec`: Codec name (h264, vp9, av1, etc.)
- `bitrate`: Bitrate in kbps

**Example:**
```typescript
const metadata = await ffmpegService.getVideoMetadata(file);
console.log(`Codec: ${metadata.codec}, Duration: ${metadata.duration}s`);
```

### `ffmpegService.initialize()`

Initialize FFmpeg instance (loads ~30MB core files).

```typescript
async function initialize(onProgress?: (progress: number) => void): Promise<void>
```

**Behavior:**
- Downloads FFmpeg core from CDN (unpkg)
- Loads `@ffmpeg/core-mt` for multithreading
- Sets up worker pool
- Caches assets for 15 minutes

---

## WebCodecs Services

### WebCodecs Conversion Service

**File**: `src/services/webcodecs-conversion-service.ts`

#### `convert()`

Convert video using WebCodecs API (GPU-accelerated).

```typescript
async function convert(
  file: File,
  options: ConversionOptions,
  onProgress?: ConversionProgressCallback
): Promise<Blob>
```

**Supported Codecs**: AV1, VP9, H.264 (when WebCodecs available)

**Output Formats**: WebP (preferred), GIF (via modern-gif)

**Fallback**: Automatically falls back to FFmpeg on decode errors

**Example:**
```typescript
import { convert } from './services/webcodecs-conversion-service';

try {
  const blob = await convert(file, options, onProgress);
  // WebCodecs path succeeded
} catch (error) {
  // Falls back to FFmpeg automatically in conversion-service
}
```

### WebCodecs Decoder

**File**: `src/services/webcodecs-decoder.ts`

#### `decodeToFrames()`

Decode video to frame data using WebCodecs VideoDecoder.

```typescript
async function decodeToFrames(
  file: File,
  codec: string,
  options: {
    maxFrames?: number;
    captureMode?: 'auto' | 'track' | 'frame-callback' | 'seek';
    onProgress?: (current: number, total: number) => void;
  }
): Promise<ImageData[]>
```

**Capture Modes:**
- `auto`: Auto-select best mode for browser
- `track`: Use MediaStreamTrackProcessor (Chrome 94+)
- `frame-callback`: Use requestVideoFrameCallback (Safari, Firefox)
- `seek`: Fallback using video.currentTime

**Returns**: Promise<ImageData[]> - Array of decoded frames

**Throws**: Error if decoding fails or too many empty frames

### WebCodecs Support

**File**: `src/services/webcodecs-support.ts`

#### `isWebCodecsSupported()`

Check if WebCodecs API is available.

```typescript
function isWebCodecsSupported(): boolean
```

**Returns**: true if VideoDecoder exists

#### `canDecodeCodec()`

Check if specific codec is supported by WebCodecs.

```typescript
async function canDecodeCodec(codec: string): Promise<boolean>
```

**Example:**
```typescript
const canDecode = await canDecodeCodec('av01.0.05M.08');
if (canDecode) {
  // Use WebCodecs path
}
```

---

## Video Analysis

**File**: `src/services/video-analyzer.ts`

### `analyzeVideoQuick()`

Quick analysis using File API (no decoding).

```typescript
async function analyzeVideoQuick(file: File): Promise<VideoMetadata | null>
```

**Returns**: Basic metadata or null if unavailable

**Performance**: ~100ms, no FFmpeg needed

### `analyzeVideo()`

Full analysis using FFmpeg.

```typescript
async function analyzeVideo(
  file: File,
  onProgress?: (progress: number) => void
): Promise<VideoMetadata>
```

**Returns**: Complete VideoMetadata with codec, bitrate, etc.

**Performance**: ~500ms-2s depending on file size

---

## Types

**File**: `src/types/conversion-types.ts`

### `ConversionFormat`

```typescript
type ConversionFormat = 'gif' | 'webp';
```

### `ConversionQuality`

```typescript
type ConversionQuality = 'low' | 'medium' | 'high';
```

### `ConversionScale`

```typescript
type ConversionScale = '0.5' | '0.75' | '1';
```

### `ConversionOptions`

```typescript
interface ConversionOptions {
  format: ConversionFormat;
  quality: ConversionQuality;
  scale: ConversionScale;
}
```

### `ConversionProgressCallback`

```typescript
type ConversionProgressCallback = (
  progress: number,    // 0-100
  message: string      // Status message
) => void;
```

### `VideoMetadata`

```typescript
interface VideoMetadata {
  duration: number;      // seconds
  width: number;         // pixels
  height: number;        // pixels
  framerate: number;     // fps
  codec: string;         // 'h264', 'vp9', 'av1', etc.
  bitrate: number;       // kbps
}
```

### `ConversionResult`

```typescript
interface ConversionResult {
  blob: Blob;
  format: ConversionFormat;
  outputSize: number;    // bytes
  settings: ConversionOptions;
  timestamp: number;     // Date.now()
}
```

---

## Utilities

### Logger

**File**: `src/utils/logger.ts`

```typescript
const logger = {
  debug(category: LogCategory, message: string, context?: unknown): void;
  info(category: LogCategory, message: string, context?: unknown): void;
  warn(category: LogCategory, message: string, context?: unknown): void;
  error(category: LogCategory, message: string, context?: unknown): void;
};
```

**Categories:**
- `'app'`: Application-level events
- `'conversion'`: Conversion flow
- `'ffmpeg'`: FFmpeg operations
- `'webcodecs'`: WebCodecs operations

**Example:**
```typescript
import { logger } from './utils/logger';

logger.info('conversion', 'Starting conversion', {
  format: 'gif',
  quality: 'high'
});
```

### Memory Monitor

**File**: `src/utils/memory-monitor.ts`

#### `isMemoryCritical()`

Check if system memory is critically low.

```typescript
function isMemoryCritical(): boolean
```

**Returns**: true if available memory < 512MB

#### `getMemoryInfo()`

Get current memory status.

```typescript
function getMemoryInfo(): {
  total?: number;
  used?: number;
  available?: number;
  warningLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
}
```

#### `estimateConversionMemory()`

Estimate memory needed for conversion.

```typescript
function estimateConversionMemory(
  videoSize: number,
  duration: number,
  width: number,
  height: number
): number
```

**Returns**: Estimated memory in bytes

### File Validation

**File**: `src/utils/file-validation.ts`

#### `validateVideoFile()`

Validate video file format and codec.

```typescript
async function validateVideoFile(file: File): Promise<{
  valid: boolean;
  error?: string;
  codec?: string;
}>
```

**Checks:**
- File type is video/*
- File size < 500MB
- Codec is supported (h264, vp9, av1, etc.)

**Example:**
```typescript
const result = await validateVideoFile(file);
if (!result.valid) {
  console.error(result.error);
}
```

### Error Classification

**File**: `src/utils/classify-conversion-error.ts`

#### `classifyConversionError()`

Classify error for user-friendly messaging.

```typescript
function classifyConversionError(error: unknown): {
  type: ErrorType;
  message: string;
  suggestion?: string;
}
```

**Error Types:**
- `'network'`: Download failures
- `'unsupported-format'`: Unknown codec
- `'memory'`: Out of memory
- `'timeout'`: Operation timeout
- `'user-cancelled'`: User aborted
- `'unknown'`: Unexpected errors

---

## Stores

### App Store

**File**: `src/stores/app-store.ts`

```typescript
// State
const [appState, setAppState] = createSignal<AppState>('idle');
const [environmentSupported, setEnvironmentSupported] = createSignal(true);
const [loadingProgress, setLoadingProgress] = createSignal(0);
const [loadingStatusMessage, setLoadingStatusMessage] = createSignal('');

// Types
type AppState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'analyzing'
  | 'ready-to-convert'
  | 'converting'
  | 'converted'
  | 'error';
```

### Conversion Store

**File**: `src/stores/conversion-store.ts`

```typescript
// State
const [inputFile, setInputFile] = createSignal<File | null>(null);
const [videoMetadata, setVideoMetadata] = createSignal<VideoMetadata | null>(null);
const [conversionSettings, setConversionSettings] = createSignal<ConversionSettings>(DEFAULT);
const [conversionProgress, setConversionProgress] = createSignal(0);
const [conversionResults, setConversionResults] = createSignal<ConversionResult[]>([]);
const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

// Helpers
function saveConversionSettings(settings: ConversionSettings): void;
```

### Theme Store

**File**: `src/stores/theme-store.ts`

```typescript
const [theme, setTheme] = createSignal<'light' | 'dark' | 'system'>('system');
const effectiveTheme = createMemo(() => {
  // Returns 'light' or 'dark' based on theme + system preference
});
```

---

## Constants

### Quality Presets

**File**: `src/utils/quality-presets.ts`

```typescript
const QUALITY_PRESETS: Record<ConversionFormat, Record<ConversionQuality, Preset>> = {
  gif: {
    low: { fps: 8, quality: 60 },
    medium: { fps: 10, quality: 75 },
    high: { fps: 12, quality: 90 }
  },
  webp: {
    low: { fps: 10, quality: 60 },
    medium: { fps: 15, quality: 75 },
    high: { fps: 20, quality: 85 }
  }
};
```

### FFmpeg Constants

**File**: `src/utils/ffmpeg-constants.ts`

```typescript
const FFMPEG_INTERNALS = {
  TIMEOUT: {
    INITIALIZATION: 120000,  // 2 minutes
    METADATA: 30000,         // 30 seconds
    CONVERSION: 300000       // 5 minutes
  },
  PROGRESS: {
    INIT_START: 0,
    INIT_END: 5,
    METADATA_START: 5,
    METADATA_END: 10,
    WEBCODECS: {
      DECODE_START: 10,
      DECODE_END: 70,
      ENCODE_START: 70,
      ENCODE_END: 100
    },
    FFMPEG: {
      START: 10,
      END: 100
    }
  }
};
```

---

## Usage Examples

### Complete Conversion Flow

```typescript
import { convertVideo } from './services/conversion-service';
import { ffmpegService } from './services/ffmpeg-service';
import { logger } from './utils/logger';

// 1. Initialize FFmpeg
await ffmpegService.initialize((progress) => {
  console.log(`Loading FFmpeg: ${progress}%`);
});

// 2. Validate file
const validation = await validateVideoFile(file);
if (!validation.valid) {
  throw new Error(validation.error);
}

// 3. Analyze video
const metadata = await ffmpegService.getVideoMetadata(file);
logger.info('app', 'Video analyzed', metadata);

// 4. Convert
const blob = await convertVideo(
  file,
  { format: 'gif', quality: 'high', scale: '1' },
  (progress, message) => {
    console.log(`${progress}%: ${message}`);
  }
);

// 5. Download result
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'output.gif';
a.click();
URL.revokeObjectURL(url);
```

### Error Handling

```typescript
import { classifyConversionError } from './utils/classify-conversion-error';

try {
  const blob = await convertVideo(file, options, onProgress);
} catch (error) {
  const classified = classifyConversionError(error);

  switch (classified.type) {
    case 'memory':
      console.error('Out of memory. Suggestion:', classified.suggestion);
      break;
    case 'unsupported-format':
      console.error('Unsupported codec');
      break;
    default:
      console.error('Conversion failed:', classified.message);
  }
}
```

---

## Performance Tips

1. **Use Quick Analysis First**: Call `analyzeVideoQuick()` before `analyzeVideo()` for instant feedback
2. **Throttle Progress Updates**: Progress callbacks fire frequently; throttle UI updates to ~100ms
3. **Check Memory Before WebCodecs**: Call `isMemoryCritical()` before attempting WebCodecs decoding
4. **Reuse FFmpeg Instance**: `ffmpegService` is a singleton; initialization is cached
5. **Clean Up Blobs**: Revoke object URLs with `URL.revokeObjectURL()` after use

---

## Debugging

### Enable Verbose Logging

Set in browser console:
```javascript
localStorage.setItem('debug', 'true');
```

### Check Cross-Origin Isolation

```javascript
console.log('crossOriginIsolated:', crossOriginIsolated);
console.log('SharedArrayBuffer:', typeof SharedArrayBuffer);
```

### Inspect FFmpeg Logs

FFmpeg logs are captured via `logger.debug('ffmpeg', ...)`. Check browser console for detailed output.

---

## Type Definitions

See `src/types/` directory for complete type definitions:
- `conversion-types.ts`: Core conversion types
- `vite-env.d.ts`: Vite environment augmentations

---

This API reference covers the core public APIs. For internal implementation details, refer to [ARCHITECTURE.md](./ARCHITECTURE.md).
