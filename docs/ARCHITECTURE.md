# Architecture Documentation

## System Overview

**dropconvert-wasm** is a browser-based video conversion application that transforms video files into GIF or WebP formats entirely client-side, without server uploads. The application leverages two conversion paths for optimal performance:

1. **WebCodecs API** (GPU-accelerated, modern browsers)
2. **FFmpeg.wasm** (Fallback for broader compatibility)

### Technology Stack

- **Framework**: SolidJS 1.9+ (fine-grained reactivity)
- **Build Tool**: Vite 7+
- **Language**: TypeScript 5.9+ (strict mode)
- **Styling**: Tailwind CSS 4+
- **Conversion Engines**:
  - ffmpeg.wasm (@ffmpeg/ffmpeg 0.12.15+)
  - WebCodecs API (native browser API)
  - modern-gif (GIF encoding library)
- **Deployment**: Cloudflare Pages (with COOP/COEP headers for SharedArrayBuffer)

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser UI                           │
│                     (SolidJS Components)                     │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ↓
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                         │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐│
│  │   App State    │  │  Conversion    │  │     Theme      ││
│  │     Store      │  │  Settings      │  │     Store      ││
│  │                │  │     Store      │  │                ││
│  └────────────────┘  └────────────────┘  └────────────────┘│
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ↓
┌─────────────────────────────────────────────────────────────┐
│                     Service Layer                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         Conversion Service (Orchestrator)             │  │
│  │     • Codec detection & path selection               │  │
│  │     • Error handling & fallback logic                │  │
│  └──────────────┬──────────────────────┬─────────────────┘  │
│                 │                      │                     │
│      ┌──────────▼──────────┐  ┌───────▼──────────┐         │
│      │  WebCodecs Path     │  │   FFmpeg Path    │         │
│      │  ┌───────────────┐  │  │  ┌─────────────┐ │         │
│      │  │  Decoder      │  │  │  │   VFS Mgmt  │ │         │
│      │  │  (4 modes)    │  │  │  │             │ │         │
│      │  └───────┬───────┘  │  │  └─────┬───────┘ │         │
│      │          │          │  │        │         │         │
│      │  ┌───────▼───────┐  │  │  ┌─────▼───────┐ │         │
│      │  │  WebP/GIF     │  │  │  │  Encoding   │ │         │
│      │  │  Encoding     │  │  │  │   (GIF)     │ │         │
│      │  └───────────────┘  │  │  └─────────────┘ │         │
│      └─────────────────────┘  └──────────────────┘         │
└─────────────────────────────────────────────────────────────┘
                        │
                        ↓
┌─────────────────────────────────────────────────────────────┐
│                    Utility Layer                             │
│  • Logger  • Memory Monitor  • File Validation              │
│  • Progress Calculation  • Error Classification             │
└─────────────────────────────────────────────────────────────┘
```

---

## Conversion Pipeline

### Stage 1: Validation & Analysis

```
Video File Input
      │
      ↓
┌──────────────────────┐
│  File Validation     │  ← file-validation.ts
│  • Format check      │
│  • Codec detection   │
│  • Size limits       │
└──────┬───────────────┘
       │
       ↓
┌──────────────────────┐
│  Video Analysis      │  ← video-analyzer.ts
│  • Quick metadata    │
│  • Full analysis     │
│  • Performance check │
└──────┬───────────────┘
       │
       ↓
   Validated Input
```

### Stage 2: Conversion Path Selection

```
                  Validated Input
                        │
                        ↓
         ┌──────────────────────────────┐
         │   Conversion Service         │
         │   • Check codec support      │
         │   • Memory availability      │
         │   • Browser capabilities     │
         └──────────┬───────────────────┘
                    │
          ┌─────────┴──────────┐
          │                    │
    WebCodecs Path        FFmpeg Path
          │                    │
          ↓                    ↓
   GPU Acceleration      Universal Support
```

**Decision Criteria:**

| Condition | Path Selected |
|-----------|---------------|
| AV1 codec + WebCodecs support + WebP output | WebCodecs |
| VP9 codec + WebCodecs support + WebP output | WebCodecs |
| H.264 codec + WebCodecs support + WebP output | WebCodecs |
| GIF output (any codec) | FFmpeg |
| WebCodecs unsupported | FFmpeg |
| Memory critical | FFmpeg (smaller footprint) |

### Stage 3: Decoding & Frame Extraction

#### WebCodecs Path

```
Video Input
     │
     ↓
┌────────────────────────┐
│  VideoDecoder Setup    │
│  • Codec configuration │
│  • Buffer allocation   │
└────────┬───────────────┘
         │
         ↓
┌────────────────────────┐
│  Frame Capture         │  ← webcodecs-decoder.ts
│  (4 modes - auto)      │
│  ┌──────────────────┐  │
│  │ 1. Track Mode    │  │ MediaStreamTrackProcessor
│  │ 2. Frame Callback│  │ requestVideoFrameCallback
│  │ 3. Seek Mode     │  │ Seek + readback
│  │ 4. Auto Select   │  │ Best available
│  └──────────────────┘  │
└────────┬───────────────┘
         │
         ↓
   Decoded Frames (ImageData)
```

#### FFmpeg Path

```
Video Input
     │
     ↓
┌────────────────────────┐
│  FFmpeg Initialization │
│  • Load core (~30MB)   │
│  • Worker setup        │
│  • VFS mount           │
└────────┬───────────────┘
         │
         ↓
┌────────────────────────┐
│  Frame Extraction      │
│  • ffmpeg -i input     │
│  • Extract to VFS      │
│  • frame_%04d.png      │
└────────┬───────────────┘
         │
         ↓
   Frame Files in VFS
```

### Stage 4: Encoding

#### WebP Encoding (WebCodecs Path)

```
Decoded Frames
     │
     ↓
┌────────────────────────┐
│  WebP Frame Encoding   │
│  • ImageDecoder setup  │
│  • Frame-by-frame      │
│  • Quality control     │
└────────┬───────────────┘
         │
         ↓
┌────────────────────────┐
│  WebP Muxing           │
│  • Combine frames      │
│  • Set duration        │
│  • Finalize blob       │
└────────┬───────────────┘
         │
         ↓
   WebP Output Blob
```

#### GIF Encoding (FFmpeg or modern-gif)

```
Frame Data
     │
     ↓
┌────────────────────────┐
│  Encoder Selection     │
│  ┌──────────────────┐  │
│  │ modern-gif       │  │ ← Fast, browser-based
│  │ (preferred)      │  │
│  ├──────────────────┤  │
│  │ FFmpeg fallback  │  │ ← Universal compatibility
│  └──────────────────┘  │
└────────┬───────────────┘
         │
         ↓
   GIF Output Blob
```

---

## Service Layer Details

### 1. Conversion Service (`src/services/conversion-service.ts`)

**Responsibilities:**
- Orchestrates entire conversion flow
- Codec-aware path selection
- Error handling and fallback logic
- Progress callback management

**Key Functions:**
```typescript
convertVideo(
  file: File,
  options: ConversionOptions,
  onProgress?: ConversionProgressCallback
): Promise<Blob>
```

**Flow:**
1. Validate input file
2. Analyze video metadata
3. Check memory availability
4. Select conversion path (WebCodecs vs FFmpeg)
5. Execute conversion with progress tracking
6. Handle errors and attempt fallback
7. Return output blob

### 2. WebCodecs Conversion Service (`src/services/webcodecs-conversion-service.ts`)

**Responsibilities:**
- GPU-accelerated video decoding
- WebP/GIF encoding from decoded frames
- Frame extraction and validation
- Fallback to FFmpeg when needed

**Key Functions:**
```typescript
convert(
  file: File,
  options: ConversionOptions,
  onProgress?: ConversionProgressCallback
): Promise<Blob>
```

**Internal Process:**
1. Check WebCodecs support for codec
2. Initialize VideoDecoder
3. Decode frames via webcodecs-decoder
4. Validate frame quality
5. Encode to target format (WebP/GIF)
6. Return blob with metadata

### 3. WebCodecs Decoder (`src/services/webcodecs-decoder.ts`)

**Responsibilities:**
- Frame-by-frame video decoding
- 4 capture modes for browser compatibility
- Frame validation and quality checks
- Memory-efficient frame handling

**Capture Modes:**

| Mode | API | Use Case |
|------|-----|----------|
| `track` | MediaStreamTrackProcessor | Chrome 94+, hardware accel |
| `frame-callback` | requestVideoFrameCallback | Safari, Firefox |
| `seek` | video.currentTime + drawImage | Fallback |
| `auto` | Auto-select best available | Default |

### 4. FFmpeg Service (`src/services/ffmpeg-service.ts`)

**Responsibilities:**
- FFmpeg initialization and lifecycle
- Virtual File System (VFS) operations
- GIF/WebP encoding
- Progress parsing from FFmpeg logs
- Worker pool management
- Asset caching

**Key Functions:**
```typescript
convertToGIF(file: File, options): Promise<Blob>
convertToWebP(file: File, options): Promise<Blob>
getVideoMetadata(file: File): Promise<VideoMetadata>
```

**VFS Workflow:**
1. Write input file to VFS (`/input.mp4`)
2. Execute ffmpeg command
3. Read output from VFS (`/output.gif`)
4. Cleanup VFS files
5. Return blob

### 5. Supporting Services

- **`video-analyzer.ts`**: Quick and full video analysis
- **`performance-checker.ts`**: Memory and capability checks
- **`webcodecs-support.ts`**: Browser feature detection
- **`quality-optimizer.ts`**: Quality preset management

---

## State Management

### Store Architecture

The application uses SolidJS signals and stores for reactive state management:

```
┌──────────────────────────────────────────────────────┐
│                    app-store.ts                       │
│  • appState: 'idle' | 'loading' | 'ready' | ...      │
│  • environmentSupported: boolean                     │
│  • loadingProgress: number                           │
│  • loadingStatusMessage: string                      │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│                 conversion-store.ts                   │
│  • inputFile: File | null                            │
│  • videoMetadata: VideoMetadata | null               │
│  • conversionSettings: ConversionSettings            │
│  • conversionProgress: number                        │
│  • conversionResults: ConversionResult[]             │
│  • errorMessage: string | null                       │
│  • performanceWarnings: string[]                     │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│                    theme-store.ts                     │
│  • theme: 'light' | 'dark' | 'system'                │
│  • effectiveTheme: 'light' | 'dark'                  │
└──────────────────────────────────────────────────────┘
```

### State Transitions

```
idle
  │
  ↓ (FFmpeg initialization)
loading
  │
  ↓ (FFmpeg loaded)
ready
  │
  ↓ (File selected & validated)
analyzing
  │
  ↓ (Analysis complete)
ready-to-convert
  │
  ↓ (Convert clicked)
converting
  │
  ├─→ (Success) → converted
  │
  └─→ (Error) → error
```

---

## Component Hierarchy

```
App
├── EnvironmentWarning (if !crossOriginIsolated)
├── ThemeToggle
├── Main Content
│   ├── Left Panel
│   │   ├── FileDropzone
│   │   │   └── ProgressBar (during loading/conversion)
│   │   ├── VideoMetadataDisplay
│   │   ├── InlineWarningBanner (performance warnings)
│   │   ├── FormatSelector
│   │   │   └── OptionSelector
│   │   ├── QualitySelector
│   │   │   └── OptionSelector
│   │   └── ScaleSelector
│   │       └── OptionSelector
│   │
│   └── Right Panel
│       ├── ConversionProgress (when converting)
│       ├── ErrorDisplay (on error)
│       └── ResultPreview (on success)
│
└── LicenseAttribution
```

---

## Data Flow

### File Upload to Conversion

```
1. User drops file
        ↓
2. FileDropzone validates format
        ↓
3. App.tsx → validateVideoFile()
        ↓
4. App.tsx → analyzeVideo() (quick or full)
        ↓
5. Update stores (inputFile, videoMetadata)
        ↓
6. UI enables conversion controls
        ↓
7. User configures settings & clicks Convert
        ↓
8. App.tsx → convertVideo(file, options, onProgress)
        ↓
9. conversion-service selects path
        ↓
10. Execute conversion (WebCodecs or FFmpeg)
        ↓
11. Progress callbacks → update UI
        ↓
12. Blob returned → ResultPreview displays
```

### Progress Reporting

```
Service Layer
      │
      ↓ onProgress({ progress: 0-100, message: string })
App.tsx (callback handler)
      │
      ↓ setConversionProgress(), setConversionStatusMessage()
Stores Updated
      │
      ↓ Reactive signals trigger re-render
UI Components (ConversionProgress, ProgressBar)
      │
      ↓ Display updated progress
```

---

## Error Handling Strategy

### Error Classification

Errors are classified by type using `classify-conversion-error.ts`:

| Error Class | Examples | Recovery Strategy |
|-------------|----------|-------------------|
| `network` | FFmpeg download failure | Retry initialization |
| `unsupported-format` | Unknown codec | Show format error |
| `memory` | Out of memory | Suggest smaller file |
| `timeout` | Watchdog timeout | Retry with simpler settings |
| `user-cancelled` | User aborted | Clear state |
| `unknown` | Unexpected errors | Generic error message |

### Fallback Paths

```
WebCodecs Conversion Attempt
         │
         ↓ (Decode failure)
    ┌────────────┐
    │  Fallback  │
    │  to FFmpeg │
    └──────┬─────┘
           │
           ↓
    FFmpeg Conversion
         │
         ↓ (Success or fatal error)
      Result
```

---

## Memory Management

### Memory Monitoring

The `memory-monitor.ts` utility tracks:
- **System memory** (via `performance.memory` or `navigator.deviceMemory`)
- **Conversion requirements** (estimated based on video size/duration)
- **Warning levels** (low, medium, high, critical)

### Memory-Critical Handling

When `isMemoryCritical()` returns true:
1. Skip WebCodecs path (higher memory usage)
2. Use FFmpeg with conservative settings
3. Display memory warning to user
4. Suggest reducing scale/quality

---

## Threading & Workers

### FFmpeg Multithreading

FFmpeg.wasm uses SharedArrayBuffer for multithreading:

```
Main Thread
    │
    ├─→ FFmpeg Worker 1
    ├─→ FFmpeg Worker 2
    ├─→ FFmpeg Worker 3
    └─→ FFmpeg Worker 4
```

**Requirements:**
- `crossOriginIsolated === true`
- COOP/COEP headers set
- `@ffmpeg/core-mt` variant

### Threading Arguments

Determined by `getThreadingArgs()` in `ffmpeg-constants.ts`:
- Detects CPU core count
- Limits to 4 threads max
- Disables threading if SharedArrayBuffer unavailable

---

## Cross-Origin Isolation

### Why Required

- **SharedArrayBuffer** (FFmpeg multithreading) requires cross-origin isolation
- **Security requirement** to prevent Spectre attacks

### Implementation

**Development (vite.config.ts):**
```typescript
server: {
  headers: {
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
  },
}
```

**Production (public/_headers):**
```
/*
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Opener-Policy: same-origin
```

### Validation

App checks on mount:
```typescript
if (!crossOriginIsolated) {
  // Show EnvironmentWarning
  // Disable multithreading
}
```

---

## Performance Optimizations

### 1. Asset Caching
- FFmpeg core files cached via `toBlobURL()`
- 15-minute self-cleaning cache for repeat conversions

### 2. Lazy Loading
- FFmpeg initialization deferred until first use
- WebCodecs features detected on demand

### 3. Frame Validation
- Skip empty/corrupt frames during decode
- Limit consecutive empty frames (max 2)

### 4. Progress Throttling
- ETA updates throttled to 1/second
- Prevents excessive UI re-renders

### 5. Idle Callbacks
- Use `requestIdleCallback()` for non-critical work
- Fallback to setTimeout for unsupported browsers

### 6. Codec-Aware Paths
- AV1/VP9 → WebCodecs (GPU-accelerated)
- H.264 → WebCodecs or FFmpeg (based on output)
- GIF → FFmpeg (better quality)

---

## Security Considerations

### No Server Uploads
- All processing client-side
- Files never leave user's browser
- Privacy-preserving architecture

### File Validation
- Format/codec validation before processing
- Size limits enforced
- Reject unexpected file types

### Sandboxed Execution
- FFmpeg runs in Web Worker
- VFS isolated from main thread
- No file system access

---

## Future Architecture Improvements

### Potential Enhancements

1. **Service Worker for Offline Support**
   - Cache FFmpeg core files
   - Offline conversion capability

2. **Web Worker for WebCodecs**
   - Move decoding off main thread
   - Better UI responsiveness

3. **Streaming Conversion**
   - Process frames as they decode
   - Reduce memory footprint

4. **Batch Processing**
   - Multiple files in queue
   - Sequential or parallel processing

5. **Advanced Codec Support**
   - HEVC/H.265 decoding
   - AV2 when available

6. **Plugin Architecture**
   - Custom encoders
   - Filter effects
   - Output format extensions

---

## Conclusion

The dropconvert-wasm architecture prioritizes:
- **Performance** (GPU acceleration when available)
- **Compatibility** (Fallback paths for all browsers)
- **Privacy** (Client-side processing only)
- **Maintainability** (Clear separation of concerns)

The dual-path approach (WebCodecs + FFmpeg) ensures optimal performance on modern browsers while maintaining broad compatibility across all platforms.
