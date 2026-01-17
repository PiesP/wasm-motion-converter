/**
 * Maximum number of frames for WebP animation.
 * Limits frame count to prevent memory issues and ensure compatibility.
 */
export const WEBP_ANIMATION_MAX_FRAMES = 240;

/**
 * Maximum duration in seconds for WebP animation.
 * Prevents excessively long animations that could cause performance issues.
 */
export const WEBP_ANIMATION_MAX_DURATION_SECONDS = 10;

/**
 * Minimum frame duration in milliseconds for WebP.
 * WebP spec requires at least 8ms per frame.
 */
export const MIN_WEBP_FRAME_DURATION_MS = 8;

/**
 * Maximum frame duration value (24-bit ceiling).
 * WebP format stores duration in 24 bits: 0xFFFFFF milliseconds.
 */
export const MAX_WEBP_DURATION_24BIT = 0xffffff;

/**
 * Transparent black background color for WebP animations.
 * RGBA(0, 0, 0, 0) for proper alpha channel handling.
 */
export const WEBP_BACKGROUND_COLOR = { r: 0, g: 0, b: 0, a: 0 } as const;

/**
 * Threshold for detecting significant FPS downsampling.
 * If source FPS exceeds target FPS by more than this ratio, use uniform frame durations
 * to avoid stuttering from uneven timestamp capture.
 */
export const FPS_DOWNSAMPLING_THRESHOLD = 1.05;
