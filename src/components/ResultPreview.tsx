// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import Button from '@components/ui/Button';
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
  outputBlob: import('@t/conversion-types').ConversionOutputBlob;
  originalName: string;
  originalSize: number;
  settings: ConversionSettings;
  conversionDurationSeconds?: number;
  wasTranscoded?: boolean;
  originalCodec?: string;
}

const ResultPreview: Component<ResultPreviewProps> = (props) => {
  const [local] = splitProps(props, [
    'outputBlob',
    'originalName',
    'originalSize',
    'settings',
    'conversionDurationSeconds',
    'wasTranscoded',
    'originalCodec',
  ]);
  const [loaded, setLoaded] = createSignal(false);

  const previewUrl = createMemo(() => URL.createObjectURL(local.outputBlob));

  const conversionTimeLabel = createMemo(() => {
    if (typeof local.conversionDurationSeconds !== 'number') {
      return null;
    }
    return formatDuration(local.conversionDurationSeconds);
  });

  const sizeGridClass = createMemo(() =>
    conversionTimeLabel()
      ? 'grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm mt-3'
      : 'grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm mt-3'
  );

  const outputExtension = createMemo(() => {
    if (local.outputBlob.type === 'image/gif') {
      return 'gif';
    }
    if (local.outputBlob.type === 'image/webp') {
      return 'webp';
    }
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

  createEffect(() => {
    setLoaded(false);
  });

  // Revoke the previous blob URL whenever previewUrl changes to prevent memory leaks.
  let previousUrl: string | null = null;
  createEffect(() => {
    const url = previewUrl();
    if (previousUrl !== null && previousUrl !== url) {
      URL.revokeObjectURL(previousUrl);
    }
    previousUrl = url;
  });

  onCleanup(() => {
    if (previousUrl !== null) {
      URL.revokeObjectURL(previousUrl);
    }
  });

  const handleDownload = () => {
    const url = previewUrl();
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadFileName();
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  const handlePreviewLoad = () => {
    setLoaded(true);
  };

  return (
    <Panel class="p-6">
      <div class="flex gap-3">
        <Button
          ariaLabel="Download converted file"
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
        <img
          src={previewUrl()}
          alt="Converted animation"
          class={imageClass()}
          onLoad={handlePreviewLoad}
          loading="lazy"
          data-testid="result-image"
        />
      </div>

      <div class="mt-4" role="region" aria-label="Conversion results">
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

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm mt-3">
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
        </div>

        {/* aHash dedup stats for WebP streaming path */}
        <Show when={local.outputBlob.dedupTotalFrames && local.outputBlob.dedupTotalFrames > 0}>
          <div class="mt-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg p-3 text-sm">
            <dt class="text-blue-700 dark:text-blue-300 font-medium">Frame Similarity Optimization</dt>
            <dd class="text-blue-600 dark:text-blue-400 mt-1">
              Skipped {local.outputBlob.dedupSkippedFrames ?? 0} of {local.outputBlob.dedupTotalFrames} frames
              ({(((local.outputBlob.dedupSkippedFrames ?? 0) / (local.outputBlob.dedupTotalFrames ?? 1)) * 100).toFixed(0)}% dedup)
            </dd>
          </div>
        </Show>
      </div>
    </Panel>
  );
};

export default ResultPreview;
