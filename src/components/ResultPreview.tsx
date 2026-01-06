import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';

import { formatBytes } from '../utils/format-bytes';
import { formatDuration } from '../utils/format-duration';

import type { Component } from 'solid-js';
import type { ConversionSettings } from '../types/conversion-types';

/**
 * Scale percentage multiplier for display
 */
const SCALE_PERCENTAGE_MULTIPLIER = 100;

/**
 * Initial loaded state for image preview
 */
const INITIAL_LOADED_STATE = false;

/**
 * Result preview component props
 */
interface ResultPreviewProps {
  /** Output blob of converted file */
  outputBlob: Blob;
  /** Original file name */
  originalName: string;
  /** Original file size in bytes */
  originalSize: number;
  /** Conversion settings used */
  settings: ConversionSettings;
  /** Duration of conversion in seconds */
  conversionDurationSeconds?: number;
  /** Whether video was transcoded */
  wasTranscoded?: boolean;
  /** Original video codec */
  originalCodec?: string;
}

/**
 * Result preview component with download and metadata display
 *
 * Displays the converted file preview with download button and conversion statistics.
 * Shows original vs output size comparison, conversion time, and applied settings.
 * Handles blob URL lifecycle with automatic cleanup.
 *
 * @example
 * ```tsx
 * <ResultPreview
 *   outputBlob={convertedBlob}
 *   originalName="video.mp4"
 *   originalSize={5242880}
 *   settings={{ format: 'gif', quality: 'high', scale: 1.0 }}
 *   conversionDurationSeconds={45}
 * />
 * ```
 */
const ResultPreview: Component<ResultPreviewProps> = (props) => {
  // Create blob URL with cleanup handled by onCleanup
  const previewUrl = createMemo<string>(() => {
    return URL.createObjectURL(props.outputBlob);
  }, '');
  const [loaded, setLoaded] = createSignal(INITIAL_LOADED_STATE);

  const conversionTimeLabel = createMemo((): string | null => {
    if (typeof props.conversionDurationSeconds !== 'number') {
      return null;
    }
    return formatDuration(props.conversionDurationSeconds);
  });

  const sizeGridClass = createMemo((): string =>
    conversionTimeLabel()
      ? 'grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm mt-3'
      : 'grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm mt-3'
  );

  createEffect(() => {
    const url = previewUrl();
    setLoaded(INITIAL_LOADED_STATE);
    onCleanup(() => {
      URL.revokeObjectURL(url);
    });
  });

  const handleDownload = () => {
    const url = previewUrl();
    const extension =
      props.outputBlob.type === 'image/gif'
        ? 'gif'
        : props.outputBlob.type === 'image/webp'
          ? 'webp'
          : 'webp';
    const originalName = props.originalName.trim();
    const lastDotIndex = originalName.lastIndexOf('.');
    const baseName =
      originalName && lastDotIndex > 0 ? originalName.slice(0, lastDotIndex) : originalName;
    const safeBaseName = baseName.trim() ? baseName : 'converted';
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeBaseName}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6">
      <div class="flex gap-3">
        <button
          type="button"
          data-download-button
          aria-label="Download converted file"
          class="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-gray-900"
          onClick={handleDownload}
        >
          Download
        </button>
      </div>

      <div class="mt-4 flex justify-center bg-gray-50 dark:bg-gray-950 rounded-lg p-4 relative overflow-hidden">
        <div
          class={`absolute inset-0 transition-opacity duration-300 ${loaded() ? 'opacity-0' : 'opacity-100'}`}
        >
          <div class="w-full h-full bg-gray-200 dark:bg-gray-800 animate-pulse rounded" />
        </div>
        <img
          src={previewUrl()}
          alt="Converted animation"
          class={`max-w-full h-auto rounded transition-opacity duration-300 ${loaded() ? 'opacity-100' : 'opacity-0'}`}
          onLoad={() => setLoaded(true)}
          loading="lazy"
        />
      </div>

      <div class="mt-4">
        <h3 class="text-lg font-medium text-gray-900 dark:text-white">Conversion Complete</h3>

        <div class={sizeGridClass()}>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Original Size</div>
            <div class="font-medium text-gray-900 dark:text-white">
              {formatBytes(props.originalSize)}
            </div>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Output Size</div>
            <div class="font-medium text-gray-900 dark:text-white">
              {formatBytes(props.outputBlob.size)}
            </div>
          </div>
          <Show when={conversionTimeLabel()}>
            {(label) => (
              <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
                <div class="text-gray-600 dark:text-gray-400">Conversion Time</div>
                <div class="font-medium text-gray-900 dark:text-white">{label()}</div>
              </div>
            )}
          </Show>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm mt-3">
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Format</div>
            <div class="font-medium text-gray-900 dark:text-white uppercase">
              {props.settings.format}
            </div>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Quality</div>
            <div class="font-medium text-gray-900 dark:text-white capitalize">
              {props.settings.quality}
            </div>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Scale</div>
            <div class="font-medium text-gray-900 dark:text-white">
              {(props.settings.scale * SCALE_PERCENTAGE_MULTIPLIER).toFixed(0)}%
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ResultPreview;
