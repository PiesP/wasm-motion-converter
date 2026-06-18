// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import Panel from '@components/ui/Panel';
import type { ConversionSettings } from '@t/conversion-types';
import { formatBytes, formatDuration } from '@utils/format-utils';
import { type Component, createEffect, createMemo, createSignal, Show, splitProps } from 'solid-js';

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

  createEffect(() => {
    const blob = local.outputBlob;
    setLoaded(false);
    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
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

  const downloadUrl = createMemo(() => previewUrl());

  const handlePreviewLoad = () => setLoaded(true);

  return (
    <Panel class="p-4">
      <div class="flex gap-2">
        <a
          href={downloadUrl() ?? undefined}
          download={downloadFileName()}
          aria-label={`Download ${outputExtension().toUpperCase()} file — ${downloadFileName()}`}
          class="flex-1 inline-flex justify-center items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 dark:focus-visible:ring-offset-gray-900"
          data-testid="download-result-button"
          role="button"
        >
          Download {outputExtension().toUpperCase()}
        </a>
      </div>

      <div class="mt-3 flex justify-center bg-gray-50 dark:bg-gray-950 rounded-lg p-2 relative overflow-hidden">
        <div class={skeletonClass()}>
          <div class="w-full h-full bg-gray-200 dark:bg-gray-800 animate-pulse rounded" />
        </div>
        <Show when={previewUrl()}>
          <img
            src={previewUrl()!}
            alt="Converted animation"
            class={imageClass()}
            onLoad={handlePreviewLoad}
            data-testid="result-image"
          />
        </Show>
      </div>

      <section class="mt-3" aria-label={ariaLabel()}>
        <dl class="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
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
