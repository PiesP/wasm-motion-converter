// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import type { Component } from 'solid-js';
import { createMemo, createSignal, Show, splitProps } from 'solid-js';

import ProgressBar from './ProgressBar';

const SELECTION_FEEDBACK_DURATION_MS = 500;
const DEFAULT_STATUS = 'Processing';

interface FileDropzoneProps {
  onFileSelected: (file: File) => void;
  disabled?: boolean;
  progress?: number;
  status?: string;
  statusMessage?: string;
  showElapsedTime?: boolean;
  startTime?: number;
  estimatedSecondsRemaining?: number | null;
  subPhaseLabel?: string;
  previewUrl?: string | null;
  phase?: 'demuxing' | 'decoding' | 'encoding' | 'assembling';
}

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
    'subPhaseLabel',
    'previewUrl',
    'phase',
  ]);
  const [isDragging, setIsDragging] = createSignal(false);
  const [justSelected, setJustSelected] = createSignal(false);
  let fileInputElement: HTMLInputElement | undefined;

  const isBusy = createMemo(() => !!local.status);
  const isInteractive = createMemo(() => !local.disabled && !isBusy());
  const progressValue = createMemo(() => {
    const raw = local.progress ?? 0;
    if (!Number.isFinite(raw)) return 0;
    return Math.min(100, Math.max(0, Math.round(raw)));
  });

  const selectFile = (files?: FileList | null): void => {
    const file = files?.[0];
    if (!file) return;

    setJustSelected(true);
    setTimeout(() => setJustSelected(false), SELECTION_FEEDBACK_DURATION_MS);
    local.onFileSelected(file);
  };

  const openFilePicker = (): void => {
    if (!isInteractive()) return;
    fileInputElement?.click();
  };

  const handleDragOver = (event: DragEvent): void => {
    event.preventDefault();
    if (!isInteractive()) return;
    setIsDragging(true);
  };

  const handleDragLeave = (): void => {
    setIsDragging(false);
  };

  const handleDrop = (event: DragEvent): void => {
    event.preventDefault();
    setIsDragging(false);
    if (!isInteractive()) return;
    selectFile(event.dataTransfer?.files);
  };

  const handleFileInput = (event: Event): void => {
    const target = event.target as HTMLInputElement;
    selectFile(target.files);
    target.value = '';
  };

  return (
    <div
      class={`relative rounded-xl border-2 border-dashed transition-all ${
        isDragging()
          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
          : isInteractive()
            ? 'border-gray-300 hover:border-blue-400 dark:border-gray-600 dark:hover:border-blue-500'
            : 'border-gray-200 dark:border-gray-700'
      } ${isBusy() ? 'p-6' : 'p-12'}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-label="Video file dropzone - Press Enter or Space to select a file"
      role="region"
      data-testid="dropzone"
    >
      {/* Spinner shown during processing */}
      <Show when={isBusy()}>
        <div class="absolute right-4 top-4">
          <div class="h-5 w-5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
        </div>
      </Show>

      <Show
        when={isInteractive()}
        fallback={
          <div class="space-y-4">
            <Show when={local.subPhaseLabel}>
              <p class="text-center text-xs text-gray-500 dark:text-gray-400 font-medium">
                {local.subPhaseLabel}
              </p>
            </Show>
            <div class="max-w-md mx-auto">
              <ProgressBar
                progress={progressValue()}
                status={local.status || DEFAULT_STATUS}
                statusMessage={local.statusMessage}
                showSpinner={false}
                showElapsedTime={local.showElapsedTime}
                startTime={local.startTime}
                estimatedSecondsRemaining={local.estimatedSecondsRemaining}
                layout="vertical"
                phase={local.phase}
              />
            </div>
          </div>
        }
      >
        <div class="text-center">
          {/* Video preview when file is selected */}
          <Show when={local.previewUrl}>
            <video
              src={local.previewUrl!}
              class="w-full rounded-lg shadow-md bg-black aspect-video mb-4"
              muted
              playsinline
              preload="metadata"
              aria-label="Selected video preview"
            />
          </Show>
          <svg
            class="mx-auto h-12 w-12 text-gray-500"
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
          <div class="mt-4">
            <button
              type="button"
              onClick={openFilePicker}
              class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-gray-900"
              disabled={!isInteractive()}
              data-testid="choose-file-button"
            >
              Choose a video file
            </button>
            <input
              ref={(el) => {
                fileInputElement = el;
              }}
              id="file-upload"
              type="file"
              class="absolute opacity-0 w-0 h-0 overflow-hidden"
              accept="video/*"
              onChange={handleFileInput}
              disabled={local.disabled}
              tabIndex={-1}
              aria-label="Select video file for conversion"
              data-testid="file-input"
            />
          </div>
          <p class="mt-2 text-sm text-gray-600 dark:text-gray-400">or drag and drop</p>
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-500">
            Most video formats (MP4, MOV, WebM, MKV, AVI) - max 500MB
          </p>
        </div>
      </Show>

      <Show when={justSelected()}>
        <div class="mt-2 text-center text-sm text-green-600 dark:text-green-400">
          File selected!
        </div>
      </Show>
    </div>
  );
};

export default FileDropzone;
