// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { Component } from 'solid-js';
import { createMemo, createSignal, Show, splitProps } from 'solid-js';

import ProgressBar from './ProgressBar';

const SELECTION_FEEDBACK_DURATION_MS = 500;

interface FileDropzoneProps {
  onFileSelected: (file: File) => void;
  onCancel?: () => void;
  onClear?: () => void;
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
  outputFrames?: number;
  fileName?: string;
  fileSize?: number;
  metadataSummary?: string;
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
    'subPhaseLabel',
    'previewUrl',
    'phase',
    'outputFrames',
    'fileName',
    'fileSize',
    'metadataSummary',
  ]);
  const [isDragging, setIsDragging] = createSignal(false);
  const [justSelected, setJustSelected] = createSignal(false);
  let fileInputElement: HTMLInputElement | undefined;

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
          class="absolute right-3 top-3 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full bg-red-500/10 text-red-400 transition-colors hover:bg-red-500/20"
          aria-label={t('dropzone.cancelConversion')}
          title={t('dropzone.cancelConversion')}
        >
          <svg class="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="1" />
          </svg>
        </button>
      </Show>
      <div
        class={`relative rounded-lg border border-dashed transition-all duration-300 ${
          isDragging()
            ? 'border-[#5e6ad2] bg-white/[0.04]'
            : isInteractive()
              ? 'border-white/[0.08] hover:border-[#5e6ad2] hover:bg-white/[0.04] bg-white/[0.02]'
              : 'border-white/[0.06] bg-white/[0.01]'
        } ${isBusy() ? 'p-4' : hasFile() ? 'p-4' : 'p-6 sm:p-12'}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openFilePicker();
          }
        }}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: dropzone region is interactive (opens file picker on Enter/Space)
        tabIndex={0}
        aria-label={ariaLabel()}
        aria-busy={isBusy()}
        role="button"
        data-testid="dropzone"
      >
        {/* Busy state: compact progress card (아이디어 1 — 통합 카드) */}
        <Show when={isBusy()}>
          <div class="space-y-3">
            {/* File header with name + change button */}
            <Show when={hasFile()}>
              <div class="flex items-center gap-2 text-xs text-[#8a8f98]">
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
                  <span class="shrink-0 text-[#8a8f98]">· {local.metadataSummary}</span>
                </Show>
                <Show when={local.onClear && !isBusy()}>
                  <button
                    type="button"
                    onClick={local.onClear}
                    class="ml-auto shrink-0 text-[#5e6ad2] hover:text-[#7e8ae8]"
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
              <div class="text-center text-sm text-[#8a8f98]">
                {local.status || t('dropzone.processing')}
              </div>
            </Show>
          }
        >
          {/* File selected but not yet converting: show preview card (아이디어 1) */}
          <Show when={hasFile() && !isBusy()}>
            <div class="space-y-3 animate-in fade-in duration-300">
              {/* File header */}
              <div class="flex items-center gap-2 text-xs text-[#8a8f98]">
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
                  <span class="shrink-0 text-[#8a8f98]">· {local.metadataSummary}</span>
                </Show>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    local.onClear?.();
                  }}
                  class="ml-auto shrink-0 text-[#5e6ad2] hover:text-[#7e8ae8]"
                >
                  {t('dropzone.changeFile')}
                </button>
              </div>

              {/* Video preview */}
              <Show when={local.previewUrl}>
                <video
                  src={local.previewUrl!}
                  class="w-full rounded-lg shadow-md bg-black aspect-video"
                  muted
                  playsinline
                  preload="metadata"
                  aria-label={t('dropzone.preview')}
                />
              </Show>
            </div>
          </Show>

          {/* Empty state: dropzone */}
          <Show when={!hasFile()}>
            <div class="text-center">
              <svg
                class="mx-auto h-8 w-8 sm:h-12 sm:w-12 text-[#8a8f98]"
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
                  class="inline-flex items-center px-4 py-3 min-h-[44px] text-sm font-medium rounded-md text-white bg-[#5e6ad2] hover:bg-[#7e8ae8] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#5e6ad2] transition-colors"
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
                  type="file"
                  class="absolute opacity-0 w-0 h-0 overflow-hidden"
                  accept="video/*"
                  onChange={handleFileInput}
                  disabled={local.disabled}
                  tabIndex={-1}
                  aria-label={t('dropzone.selectFile')}
                  data-testid="file-input"
                />
              </div>
              <p class="mt-2 text-sm text-[#8a8f98]">{t('dropzone.clickSelect')}</p>
              <p class="mt-1 text-xs text-[#5e6ad2]/60">{t('dropzone.formats')}</p>
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
