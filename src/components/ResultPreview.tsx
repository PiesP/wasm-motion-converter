// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import Panel from '@components/ui/Panel';
import type { ConversionSettings } from '@t/conversion-types';
import { formatBytes, formatDuration } from '@utils/format-utils';
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  splitProps,
} from 'solid-js';

const SCALE_PERCENTAGE_MULTIPLIER = 100;

interface ResultPreviewProps {
  outputBlob: Blob;
  originalName: string;
  originalSize: number;
  settings: ConversionSettings;
  conversionDurationSeconds?: number;
}

const ResultPreview: Component<ResultPreviewProps> = (props) => {
  const [local] = splitProps(props, [
    'outputBlob',
    'originalName',
    'originalSize',
    'settings',
    'conversionDurationSeconds',
  ]);
  const [loaded, setLoaded] = createSignal(false);
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
  const [previewError, setPreviewError] = createSignal(false);

  // Skip preview for large blobs (>10MB) to prevent stack overflow from
  // synchronous URL.createObjectURL + render cascade. The download button
  // still works correctly.
  const skipPreview = createMemo(() => local.outputBlob.size > 10 * 1024 * 1024);

  // Single createEffect: create blob URL synchronously, revoke previous on cleanup.
  // This eliminates the timing gap between revoke and create that caused
  // ERR_FILE_NOT_FOUND errors and "Preview failed to load".
  createEffect(() => {
    void local.outputBlob;
    setLoaded(false);
    setPreviewError(false);

    if (skipPreview()) {
      // Large blob: skip preview entirely, just revoke previous URL
      const prevUrl = previewUrl();
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      setPreviewUrl(null);
      return;
    }

    // Small blob: create URL synchronously so <img> gets it in the same render
    const url = URL.createObjectURL(local.outputBlob);
    setPreviewUrl(url);

    onCleanup(() => {
      const current = previewUrl();
      if (current) URL.revokeObjectURL(current);
    });
  });

  const conversionTimeLabel = createMemo(() => {
    if (typeof local.conversionDurationSeconds !== 'number') return null;
    return formatDuration(local.conversionDurationSeconds);
  });

  const outputExtension = createMemo(() => {
    if (local.outputBlob.type === 'image/gif') return 'gif';
    if (local.outputBlob.type === 'image/webp') return 'webp';
    return 'webp';
  });

  const downloadFileName = createMemo(() => {
    const originalName = local.originalName.trim();
    const lastDotIndex = originalName.lastIndexOf('.');
    const baseName =
      originalName && lastDotIndex > 0 ? originalName.slice(0, lastDotIndex) : originalName;
    const safeBaseName = baseName.trim() ? baseName : 'converted';
    return `${safeBaseName}.${outputExtension()}`;
  });

  const skeletonClass = createMemo(
    () =>
      `absolute inset-0 transition-opacity duration-300 ${loaded() ? 'opacity-0' : 'opacity-100'}`
  );

  const imageClass = createMemo(
    () =>
      `max-w-full h-auto rounded transition-opacity duration-300 ${loaded() ? 'opacity-100' : 'opacity-0'}`
  );

  const ariaLabel = createMemo(
    () =>
      `${outputExtension().toUpperCase()} conversion results: ${downloadFileName()}, ${formatBytes(local.outputBlob.size)}`
  );

  const compressionRatio = createMemo(() => {
    const orig = local.originalSize;
    const out = local.outputBlob.size;
    if (orig <= 0) return null;
    const ratio = ((orig - out) / orig) * 100;
    return ratio;
  });

  const compressionLabel = createMemo(() => {
    const ratio = compressionRatio();
    if (ratio === null) return null;
    if (ratio > 0) return `${ratio.toFixed(0)}% smaller`;
    return `${Math.abs(ratio).toFixed(0)}% larger`;
  });

  const handlePreviewLoad = () => setLoaded(true);
  const handlePreviewError = () => {
    setPreviewError(true);
    setLoaded(true);
  };

  return (
    <Panel class="p-4">
      <div class="flex gap-2">
        <a
          href={previewUrl() ?? undefined}
          download={downloadFileName()}
          aria-label={`Download ${outputExtension().toUpperCase()} file — ${downloadFileName()}`}
          class="flex-1 inline-flex justify-center items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 dark:focus-visible:ring-offset-gray-900"
          data-testid="download-result-button"
          role="button"
        >
          Download {outputExtension().toUpperCase()} · {formatBytes(local.outputBlob.size)}
        </a>
      </div>

      <div class="mt-3 flex justify-center bg-gray-50 dark:bg-gray-950 rounded-lg p-2 relative overflow-hidden">
        <Show when={!skipPreview()}>
          <div class={skeletonClass()}>
            <div class="w-full h-full bg-gray-200 dark:bg-gray-800 animate-pulse rounded" />
          </div>
        </Show>
        <Show when={skipPreview()}>
          <div class="flex flex-col items-center justify-center p-8 text-gray-400 dark:text-gray-500">
            <svg
              class="h-10 w-10 mb-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.5"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            <span class="text-xs">
              Preview skipped for large file ({formatBytes(local.outputBlob.size)})
            </span>
            <span class="text-xs mt-1">Click download to save</span>
          </div>
        </Show>
        <Show when={previewUrl() && !skipPreview()}>
          <img
            src={previewUrl()!}
            alt="Converted animation"
            class={imageClass()}
            onLoad={handlePreviewLoad}
            onError={handlePreviewError}
            data-testid="result-image"
          />
        </Show>
        <Show when={!previewUrl() && !skipPreview() && previewError()}>
          <div class="flex flex-col items-center justify-center p-8 text-gray-400 dark:text-gray-500">
            <svg
              class="h-10 w-10 mb-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.5"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
              />
            </svg>
            <span class="text-xs">Preview failed to load</span>
          </div>
        </Show>
      </div>

      <section class="mt-3" aria-label={ariaLabel()}>
        <dl class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-2">
            <dt class="text-gray-500 dark:text-gray-400 text-[10px]">Original</dt>
            <dd class="font-medium text-gray-900 dark:text-white" data-result-original-size>
              {formatBytes(local.originalSize)}
            </dd>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-2">
            <dt class="text-gray-500 dark:text-gray-400 text-[10px]">Output</dt>
            <dd class="font-medium text-gray-900 dark:text-white" data-result-output-size>
              {formatBytes(local.outputBlob.size)}
            </dd>
          </div>
          <Show when={compressionLabel()}>
            {(label) => (
              <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-2">
                <dt class="text-gray-500 dark:text-gray-400 text-[10px]">Compression</dt>
                <dd class="font-medium text-green-600 dark:text-green-400">{label()}</dd>
              </div>
            )}
          </Show>
          <Show when={conversionTimeLabel()}>
            {(label) => (
              <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-2">
                <dt class="text-gray-500 dark:text-gray-400 text-[10px]">Time</dt>
                <dd class="font-medium text-gray-900 dark:text-white">{label()}</dd>
              </div>
            )}
          </Show>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-2">
            <dt class="text-gray-500 dark:text-gray-400 text-[10px]">Format</dt>
            <dd class="font-medium text-gray-900 dark:text-white uppercase" data-result-format>
              {local.settings.format}
            </dd>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-2">
            <dt class="text-gray-500 dark:text-gray-400 text-[10px]">Quality</dt>
            <dd class="font-medium text-gray-900 dark:text-white capitalize" data-result-quality>
              {local.settings.quality}
            </dd>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-2">
            <dt class="text-gray-500 dark:text-gray-400 text-[10px]">Scale</dt>
            <dd class="font-medium text-gray-900 dark:text-white" data-result-scale>
              {(local.settings.scale * SCALE_PERCENTAGE_MULTIPLIER).toFixed(0)}%
            </dd>
          </div>
        </dl>
      </section>
    </Panel>
  );
};

export default ResultPreview;
