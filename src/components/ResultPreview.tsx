// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import Button from '@components/ui/Button';
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

  const sizeGridClass = createMemo(() =>
    conversionTimeLabel()
      ? 'grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm mt-3'
      : 'grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm mt-3'
  );

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

  const handleDownload = () => {
    const url = previewUrl();
    if (!url) return;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadFileName();
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  const handlePreviewLoad = () => setLoaded(true);

  return (
    <Panel class="p-6">
      <div class="flex gap-3">
        <Button
          ariaLabel={`Download ${outputExtension().toUpperCase()} file — ${downloadFileName()}`}
          class="flex-1"
          onClick={handleDownload}
          data-testid="download-result-button"
        >
          Download
        </Button>
      </div>

      <div class="mt-4 flex justify-center bg-gray-50 dark:bg-gray-950 rounded-lg p-4 relative overflow-hidden">
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

      <section class="mt-4" aria-label={ariaLabel()}>
        <h3 class="text-lg font-medium text-gray-900 dark:text-white">Conversion Complete</h3>
        <dl class={sizeGridClass()}>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <dt class="text-gray-600 dark:text-gray-400">Original Size</dt>
            <dd class="font-medium text-gray-900 dark:text-white" data-result-original-size>
              {formatBytes(local.originalSize)}
            </dd>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <dt class="text-gray-600 dark:text-gray-400">Output Size</dt>
            <dd class="font-medium text-gray-900 dark:text-white" data-result-output-size>
              {formatBytes(local.outputBlob.size)}
            </dd>
          </div>
          <Show when={conversionTimeLabel()}>
            {(label) => (
              <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
                <dt class="text-gray-600 dark:text-gray-400">Conversion Time</dt>
                <dd class="font-medium text-gray-900 dark:text-white">{label()}</dd>
              </div>
            )}
          </Show>
        </dl>
        <dl class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm mt-3">
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <dt class="text-gray-600 dark:text-gray-400">Format</dt>
            <dd class="font-medium text-gray-900 dark:text-white uppercase" data-result-format>
              {local.settings.format}
            </dd>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <dt class="text-gray-600 dark:text-gray-400">Quality</dt>
            <dd class="font-medium text-gray-900 dark:text-white capitalize" data-result-quality>
              {local.settings.quality}
            </dd>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <dt class="text-gray-600 dark:text-gray-400">Scale</dt>
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
