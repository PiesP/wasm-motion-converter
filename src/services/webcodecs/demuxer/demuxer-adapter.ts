/**
 * Common interface for video demuxers
 * Abstracts mp4box, web-demuxer, and future demuxer implementations
 */

/**
 * VideoDecoder configuration extracted from container
 * Contains codec information needed to initialize WebCodecs VideoDecoder
 */
export interface VideoDecoderConfig {
  /**
   * Full codec string with profile/level information
   * Examples:
   * - H.264: 'avc1.64001f' (High profile, level 3.1)
   * - HEVC: 'hvc1.1.6.L93.B0'
   * - AV1: 'av01.0.05M.08'
   * - VP9: 'vp09.00.10.08'
   */
  codec: string;

  /** Video width in pixels */
  codedWidth: number;

  /** Video height in pixels */
  codedHeight: number;

  /**
   * Codec-specific initialization data (extradata)
   * Required for certain codecs:
   * - H.264: avcC box (SPS/PPS)
   * - HEVC: hvcC box
   * - AV1: av1C box
   * - VP9: Optional CodecPrivate
   */
  description?: Uint8Array;
}

/**
 * Video metadata extracted from container
 */
export interface DemuxerMetadata {
  /** Video duration in seconds */
  duration: number;

  /** Source framerate (frames per second), if available */
  framerate?: number;

  /** Total number of video samples/frames in the container */
  sampleCount: number;
}

/**
 * Encoded video sample/chunk extracted from container
 * Compatible with WebCodecs EncodedVideoChunk constructor
 */
export interface EncodedVideoChunk {
  /** Sample type: 'key' for keyframes, 'delta' for non-keyframes */
  type: 'key' | 'delta';

  /** Presentation timestamp in microseconds */
  timestamp: number;

  /** Sample duration in microseconds */
  duration: number;

  /** Encoded video data */
  data: Uint8Array;
}

/**
 * Common interface for all video demuxer implementations
 *
 * This interface abstracts container-specific demuxing logic and provides
 * a uniform API for extracting encoded video samples that can be fed to
 * WebCodecs VideoDecoder.
 *
 * Implementing classes:
 * - MP4BoxDemuxer: MP4/MOV containers via mp4box.js
 * - WebMDemuxer: WebM/MKV containers via web-demuxer
 */
export interface DemuxerAdapter {
  /**
   * Initialize demuxer with video file
   *
   * Parses container structure, extracts video track metadata, and
   * prepares for sample extraction.
   *
   * @param file - Video file to demux
   * @returns VideoDecoder configuration for WebCodecs
   * @throws Error if container is invalid or unsupported
   */
  initialize(file: File): Promise<VideoDecoderConfig>;

  /**
   * Extract encoded video samples for frame extraction
   *
   * Returns an async generator that yields encoded samples at the target FPS.
   * Samples are extracted with appropriate stride to downsample from source FPS
   * to target FPS (e.g., 30 FPS source → 15 FPS target = every 2nd sample).
   *
   * Uses AsyncGenerator to prevent memory exhaustion - samples are streamed
   * incrementally rather than buffered in memory.
   *
   * @param targetFps - Target frames per second for sampling
   * @param maxFrames - Optional maximum frame count to extract
   * @returns AsyncGenerator yielding encoded samples
   */
  extractSamples(
    targetFps: number,
    maxFrames?: number
  ): AsyncGenerator<EncodedVideoChunk, void, unknown>;

  /**
   * Get video metadata (duration, FPS, sample count)
   *
   * Must be called after initialize()
   *
   * @returns Video metadata
   */
  getMetadata(): DemuxerMetadata;

  /**
   * Clean up demuxer resources
   *
   * Should be called when demuxer is no longer needed to free memory
   * and release file handles.
   */
  destroy(): void;
}
