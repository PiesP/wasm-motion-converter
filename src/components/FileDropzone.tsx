// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { Component } from 'solid-js';
import { createEffect, createMemo, createSignal, onCleanup, Show, splitProps } from 'solid-js';

import ProgressBar from './ProgressBar';
import TrimSelector from './TrimSelector';

const SELECTION_FEEDBACK_DURATION_MS = 500;

interface FileDropzoneProps {
  onFileSelected: (file: File) => void;
  onCancel?: (() => void) | undefined;
  onClear?: (() => void) | undefined;
  disabled?: boolean | undefined;
  progress?: number | undefined;
  status?: string | undefined;
  statusMessage?: string | undefined;
  showElapsedTime?: boolean | undefined;
  startTime?: number | undefined;
  estimatedSecondsRemaining?: (number | null) | undefined;
  memoryUsage?: (string | null) | undefined;
  subPhaseLabel?: string | undefined;
  previewUrl?: (string | null) | undefined;
  phase?: ('demuxing' | 'decoding' | 'encoding' | 'assembling') | undefined;
  outputFrames?: number | undefined;
  fileName?: string | undefined;
  fileSize?: number | undefined;
  metadataSummary?: string | undefined;
  duration?: number | undefined;
  estimatedFps?: number | undefined;
  trimStart?: number | undefined;
  trimEnd?: number | undefined;
  onTrimChange?: ((start: number, end: number) => void) | undefined;
}

const FileDropzone: Component<FileDropzoneProps> = (props) => {
  const { t } = useLocale();
  const [local] = splitProps(props, [
    'onFileSelected',
    'onCancel',
    'onClear',
    'disabled',
    'progress',
    'status',
    'statusMessage',
    'showElapsedTime',
    'startTime',
    'estimatedSecondsRemaining',
    'memoryUsage',
    'subPhaseLabel',
    'previewUrl',
    'phase',
    'outputFrames',
    'fileName',
    'fileSize',
    'metadataSummary',
    'duration',
    'estimatedFps',
    'trimStart',
    'trimEnd',
    'onTrimChange',
  ]);
  const [isDragging, setIsDragging] = createSignal(false);
  const [justSelected, setJustSelected] = createSignal(false);
  const [isSelectionPreviewing, setIsSelectionPreviewing] = createSignal(false);
  let fileInputElement: HTMLInputElement | undefined;
  let previewVideoElement: HTMLVideoElement | undefined;

  const isBusy = createMemo(() => !!local.status);
  const isInteractive = createMemo(() => !local.disabled && !isBusy());
  const hasFile = createMemo(() => !!local.previewUrl);
  const ariaLabel = createMemo(() => {
    if (local.disabled) return t('dropzone.selectFile');
    if (hasFile() && !isBusy()) return t('dropzone.changeFile');
    return t('dropzone.selectFile');
  });
  const progressValue = createMemo(() => {
    const raw = local.progress ?? 0;
    if (!Number.isFinite(raw)) return 0;
    return Math.min(100, Math.max(0, Math.round(raw)));
  });
  const effectiveTrimEnd = createMemo(() => {
    const duration = local.duration ?? 0;
    const trimEnd = local.trimEnd ?? 0;
    return trimEnd === 0 || trimEnd > duration ? duration : trimEnd;
  });

  const stopSelectionPreview = (): void => {
    previewVideoElement?.pause();
    setIsSelectionPreviewing(false);
  };

  const seekPreview = (seconds: number): void => {
    stopSelectionPreview();
    const video = previewVideoElement;
    if (!video || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const duration = Number.isFinite(video.duration) ? video.duration : (local.duration ?? 0);
    video.currentTime = Math.max(0, Math.min(seconds, duration));
  };

  const handleTrimChange = (start: number, end: number): void => {
    const previousStart = local.trimStart ?? 0;
    const previewTime =
      Math.abs(start - previousStart) >= 0.05 ? start : end === 0 ? effectiveTrimEnd() : end;
    local.onTrimChange?.(start, end);
    seekPreview(previewTime);
  };

  const toggleSelectionPreview = (): void => {
    const video = previewVideoElement;
    if (!video || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    if (isSelectionPreviewing()) {
      stopSelectionPreview();
      return;
    }
    video.currentTime = local.trimStart ?? 0;
    setIsSelectionPreviewing(true);
    void video.play().catch(() => setIsSelectionPreviewing(false));
  };

  const handlePreviewTimeUpdate = (): void => {
    const video = previewVideoElement;
    if (!video || !isSelectionPreviewing()) return;
    if (video.currentTime < effectiveTrimEnd() - 0.02) return;
    video.pause();
    video.currentTime = local.trimStart ?? 0;
    setIsSelectionPreviewing(false);
  };

  createEffect(() => {
    local.previewUrl;
    stopSelectionPreview();
  });

  onCleanup(() => stopSelectionPreview());

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
    <div class="relative">
      {/* Cancel button — fixed top-right during conversion, outside interactive dropzone to avoid nested controls (axe: Interactive controls must not be nested) */}
      <Show when={isBusy() && local.onCancel}>
        <button
          type="button"
          onClick={local.onCancel}
          class="absolute right-3 top-3 z-10 inline-flex min-w-[44px] min-h-[44px] items-center justify-center rounded-full bg-red-500/10 text-red-400 transition-colors hover:bg-red-500/20 cursor-pointer"
          aria-label={t('dropzone.cancelConversion')}
          title={t('dropzone.cancelConversion')}
        >
          <svg class="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="1" />
          </svg>
        </button>
      </Show>
      {/* biome-ignore lint/a11y/useSemanticElements: This is a drag-and-drop group with its own native file control; fieldset disabled semantics would block cancellation and progress controls. */}
      <div
        class={`relative rounded-lg border border-dashed transition-all duration-300 ${
          isDragging()
            ? 'border-brand bg-white/[0.04]'
            : isInteractive()
              ? 'border-border-standard hover:border-brand hover:bg-white/[0.04] bg-white/[0.02]'
              : 'border-white/[0.06] bg-white/[0.01]'
        } ${isBusy() ? 'p-4' : hasFile() ? 'p-4' : 'p-6 sm:p-12'}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        role="group"
        aria-label={ariaLabel()}
        aria-busy={isBusy()}
        data-testid="dropzone"
      >
        {/* Busy state: compact progress card (아이디어 1 — 통합 카드) */}
        <Show when={isBusy()}>
          <div class="space-y-3">
            {/* File header with name + change button */}
            <Show when={hasFile()}>
              <div class="flex items-center gap-2 text-xs text-text-tertiary">
                <svg
                  class="h-3.5 w-3.5 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
                <span class="truncate font-medium">{local.fileName}</span>
                <Show when={local.fileSize}>
                  <span class="shrink-0 text-text-tertiary">· {local.metadataSummary}</span>
                </Show>
                <Show when={local.onClear && !isBusy()}>
                  <button
                    type="button"
                    onClick={local.onClear}
                    class="ml-auto shrink-0 text-brand hover:text-brand-hover cursor-pointer"
                  >
                    {t('dropzone.changeFile')}
                  </button>
                </Show>
              </div>
            </Show>

            {/* Video preview thumbnail during conversion */}
            <Show when={hasFile() && local.previewUrl}>
              <div class="relative mx-auto w-full max-w-xs overflow-hidden rounded-lg bg-black">
                <video
                  src={local.previewUrl!}
                  class="w-full aspect-video object-contain opacity-60"
                  muted
                  playsinline
                  preload="metadata"
                  aria-label={t('dropzone.preview')}
                />
                {/* Progress overlay on video */}
                <div class="absolute inset-0 flex items-center justify-center">
                  <div class="text-center">
                    <div class="text-2xl font-bold text-white drop-shadow-lg">
                      {progressValue()}%
                    </div>
                    <div class="mt-0.5 text-[10px] text-white/80 drop-shadow">{local.status}</div>
                  </div>
                </div>
              </div>
            </Show>

            {/* Compact progress bar */}
            <div class="max-w-md mx-auto">
              <ProgressBar
                progress={progressValue()}
                status={local.status || t('dropzone.processing')}
                statusMessage={local.statusMessage}
                showSpinner={false}
                showElapsedTime={local.showElapsedTime}
                startTime={local.startTime}
                estimatedSecondsRemaining={local.estimatedSecondsRemaining}
                memoryUsage={local.memoryUsage}
                layout="vertical"
                phase={local.phase}
                outputFrames={local.outputFrames}
                compact={true}
              />
            </div>
          </div>
        </Show>

        {/* Interactive state: dropzone or file selected card */}
        <Show
          when={isInteractive()}
          fallback={
            <Show when={!isBusy()}>
              <div class="text-center text-sm text-text-tertiary">
                {local.status || t('dropzone.processing')}
              </div>
            </Show>
          }
        >
          {/* File selected but not yet converting: show preview card (아이디어 1) */}
          <Show when={hasFile() && !isBusy()}>
            <div class="space-y-3 animate-in fade-in duration-300">
              {/* File header */}
              <div class="flex items-center gap-2 text-xs text-text-tertiary">
                <svg
                  class="h-3.5 w-3.5 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
                <span class="truncate font-medium">{local.fileName}</span>
                <Show when={local.fileSize}>
                  <span class="shrink-0 text-text-tertiary">· {local.metadataSummary}</span>
                </Show>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    local.onClear?.();
                  }}
                  class="ml-auto shrink-0 text-brand hover:text-brand-hover cursor-pointer"
                >
                  {t('dropzone.changeFile')}
                </button>
              </div>

              {/* Video preview */}
              <Show when={local.previewUrl}>
                <video
                  ref={(element) => {
                    previewVideoElement = element;
                  }}
                  src={local.previewUrl!}
                  class="w-full rounded-lg shadow-md bg-black aspect-video"
                  muted
                  playsinline
                  preload="metadata"
                  aria-label={t('dropzone.preview')}
                  onTimeUpdate={handlePreviewTimeUpdate}
                  onEnded={() => setIsSelectionPreviewing(false)}
                  onPause={() => setIsSelectionPreviewing(false)}
                />
              </Show>

              <Show when={(local.duration ?? 0) > 0 && local.onTrimChange}>
                <div class="border-t border-border-standard pt-4" data-testid="input-range-editor">
                  <TrimSelector
                    duration={local.duration!}
                    trimStart={local.trimStart ?? 0}
                    trimEnd={local.trimEnd ?? 0}
                    estimatedFps={local.estimatedFps}
                    disabled={local.disabled}
                    isPreviewing={isSelectionPreviewing()}
                    onChange={handleTrimChange}
                    onPreviewSelection={toggleSelectionPreview}
                    onSeek={seekPreview}
                  />
                </div>
              </Show>
            </div>
          </Show>

          {/* Empty state: dropzone */}
          <Show when={!hasFile()}>
            <div class="text-center">
              <svg
                class="mx-auto h-8 w-8 sm:h-12 sm:w-12 text-text-tertiary"
                stroke="currentColor"
                fill="none"
                viewBox="0 0 48 48"
                aria-hidden="true"
              >
                <path
                  d="M15 8h18a3 3 0 013 3v26a3 3 0 01-3 3H15a3 3 0 01-3-3V11a3 3 0 013-3z"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
                <path
                  d="M20 18l8 5-8 5v-10z"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  fill="currentColor"
                  fill-opacity="0.15"
                />
              </svg>
              <div class="mt-4">
                <button
                  type="button"
                  onClick={openFilePicker}
                  class="inline-flex items-center px-4 py-3 min-h-[44px] text-sm font-medium rounded-md text-white bg-brand hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-brand transition-colors cursor-pointer"
                  disabled={!isInteractive()}
                  data-testid="choose-file-button"
                >
                  {t('dropzone.dropHere')}
                </button>
                <input
                  ref={(el) => {
                    fileInputElement = el;
                  }}
                  id="file-upload"
                  name="file-upload"
                  type="file"
                  class="absolute opacity-0 w-0 h-0 overflow-hidden"
                  accept="video/*"
                  onChange={handleFileInput}
                  disabled={local.disabled}
                  tabIndex={-1}
                  aria-label={t('dropzone.selectFile')}
                  data-testid="file-input"
                  autocomplete="off"
                />
              </div>
              <p class="mt-2 text-sm text-text-tertiary">{t('dropzone.clickSelect')}</p>
              <p class="mt-1 text-xs text-text-tertiary">{t('dropzone.formats')}</p>
            </div>
          </Show>
        </Show>

        <Show when={justSelected()}>
          <div class="mt-2 text-center text-sm text-green-400">{t('dropzone.dropHere')}</div>
        </Show>
      </div>
    </div>
  );
};

export default FileDropzone;
