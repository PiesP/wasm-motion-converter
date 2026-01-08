import type { Component } from 'solid-js';
import { createSignal, Show, splitProps } from 'solid-js';
import ProgressBar from './ProgressBar';

/**
 * Duration for visual feedback after file selection (ms)
 */
const SELECTION_FEEDBACK_DURATION = 500;

/**
 * File dropzone component props
 */
interface FileDropzoneProps {
  /** Callback when a file is selected */
  onFileSelected: (file: File) => void;
  /** Whether the dropzone is disabled */
  disabled?: boolean;
  /** Current progress percentage (0-100) */
  progress?: number;
  /** Current processing status text */
  status?: string;
  /** Optional detailed status message */
  statusMessage?: string;
  /** Whether to show elapsed time */
  showElapsedTime?: boolean;
  /** Processing start timestamp in milliseconds */
  startTime?: number;
  /** Estimated seconds remaining (null if unknown) */
  estimatedSecondsRemaining?: number | null;
  /** Video preview URL (null if no preview) */
  previewUrl?: string | null;
}

/**
 * File dropzone component for video file selection
 *
 * Displays a drag-and-drop zone for video file selection with support for
 * keyboard navigation, progress display, and video preview.
 * Includes accessibility features for screen readers and keyboard users.
 *
 * @example
 * ```tsx
 * <FileDropzone
 *   onFileSelected={(file) => handleFile(file)}
 *   disabled={isProcessing}
 *   progress={50}
 *   status="Converting..."
 *   previewUrl={videoUrl}
 * />
 * ```
 */
const FileDropzone: Component<FileDropzoneProps> = (props) => {
  const [local] = splitProps(props, [
    'onFileSelected',
    'disabled',
    'progress',
    'status',
    'statusMessage',
    'showElapsedTime',
    'startTime',
    'estimatedSecondsRemaining',
    'previewUrl',
  ]);
  const [isDragging, setIsDragging] = createSignal(false);
  const [justSelected, setJustSelected] = createSignal(false);
  let fileInputElement: HTMLInputElement | undefined;

  const isBusy = (): boolean => Boolean(local.status);
  const isInteractive = (): boolean => !local.disabled && !isBusy();
  const progressValue = (): number => {
    const raw = local.progress ?? 0;
    if (!Number.isFinite(raw)) {
      return 0;
    }
    return Math.min(100, Math.max(0, Math.round(raw)));
  };

  const selectFile = (files?: FileList | null): void => {
    const file = files?.[0];
    if (file) {
      setJustSelected(true);
      setTimeout(() => setJustSelected(false), SELECTION_FEEDBACK_DURATION);
      local.onFileSelected(file);
    }
  };

  const handleDragOver = (e: DragEvent): void => {
    e.preventDefault();
    if (!isInteractive()) {
      return;
    }
    setIsDragging(true);
  };

  const handleDragLeave = (): void => {
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent): void => {
    e.preventDefault();
    setIsDragging(false);
    if (!isInteractive()) {
      return;
    }
    selectFile(e.dataTransfer?.files);
  };

  const handleFileInput = (e: Event): void => {
    if (!isInteractive()) {
      return;
    }
    const input = e.target as HTMLInputElement;
    selectFile(input.files);
  };

  const openFilePicker = (): void => {
    if (!isInteractive()) {
      return;
    }
    fileInputElement?.click();
  };

  const dropzoneStateClass = (): string => {
    if (isBusy()) {
      return 'border-blue-500 bg-blue-50 dark:bg-blue-950 dark:border-blue-400';
    }
    if (isDragging() || justSelected()) {
      return 'border-blue-500 bg-blue-50 dark:bg-blue-950 dark:border-blue-400';
    }
    return 'border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-gray-400 dark:hover:border-gray-600';
  };

  const opacityClass = (): string => {
    return local.disabled && !isBusy() ? 'opacity-60 cursor-not-allowed' : '';
  };

  return (
    <div
      class={`border-2 border-dashed rounded-lg p-4 sm:p-6 md:p-8 lg:p-12 text-center transition-colors ${dropzoneStateClass()} ${opacityClass()}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      role="region"
      aria-label="Video file dropzone"
      aria-busy={isBusy()}
    >
      <Show
        when={isBusy()}
        fallback={
          <>
            <Show
              when={local.previewUrl}
              fallback={
                <svg
                  class="mx-auto h-12 w-12 text-gray-400 dark:text-gray-600"
                  stroke="currentColor"
                  fill="none"
                  viewBox="0 0 48 48"
                  aria-hidden="true"
                >
                  <path
                    d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              }
            >
              <video
                src={local.previewUrl!}
                class="mx-auto w-full max-w-md rounded-lg shadow-md bg-black"
                controls
                playsinline
                preload="metadata"
                aria-label="Selected video preview"
              />
            </Show>
            <div class="mt-4">
              <button
                type="button"
                onClick={openFilePicker}
                class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-gray-900"
                disabled={!isInteractive()}
              >
                Choose a video file
              </button>
              <input
                ref={(el) => {
                  fileInputElement = el;
                }}
                id="file-upload"
                type="file"
                class="sr-only"
                accept="video/*"
                onChange={handleFileInput}
                disabled={local.disabled}
                tabIndex={-1}
                aria-label="Select video file for conversion"
                aria-required="true"
              />
            </div>
            <p class="mt-2 text-sm text-gray-600 dark:text-gray-400">or drag and drop</p>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-500">
              Most video formats (MP4, MOV, WebM, MKV, AVI) - max 500MB
            </p>
          </>
        }
      >
        <div class="max-w-md mx-auto">
          <ProgressBar
            progress={progressValue()}
            status={local.status || 'Processing'}
            statusMessage={local.statusMessage}
            showSpinner={true}
            showElapsedTime={local.showElapsedTime}
            startTime={local.startTime}
            estimatedSecondsRemaining={local.estimatedSecondsRemaining}
            layout="vertical"
          />
        </div>
      </Show>
    </div>
  );
};

export default FileDropzone;
