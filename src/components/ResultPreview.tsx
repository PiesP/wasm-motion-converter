// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import Panel from '@components/ui/Panel';
import { useLocale } from '@hooks/use-locale';
import type { ConversionSettings } from '@t/conversion-types';
import { formatBytes, formatDurationSeconds } from '@utils/format-utils';
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
  const { t, locale } = useLocale();
  const [local] = splitProps(props, [
    'outputBlob',
    'originalName',
    'originalSize',
    'settings',
    'conversionDurationSeconds',
  ]);
  const [loaded, setLoaded] = createSignal(false);
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
  const [downloadUrl, setDownloadUrl] = createSignal<string | null>(null);
  const [previewError, setPreviewError] = createSignal(false);

  // Track the current blob URL for cleanup without triggering effect re-entry.
  // We use a plain let variable closed over by the effect, so that
  // setPreviewUrl()/setDownloadUrl() do NOT cause the effect to re-run.
  let currentUrl: string | null = null;

  createEffect(() => {
    // React to outputBlob changes
    const blob = local.outputBlob;

    // Reset state
    setLoaded(false);
    setPreviewError(false);

    // Revoke previous URL (stored in closure variable, not reactive)
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    }

    // Create a single URL shared between preview and download
    const url = URL.createObjectURL(blob);
    currentUrl = url;
    setPreviewUrl(url);
    setDownloadUrl(url);
  });

  // Cleanup on unmount
  onCleanup(() => {
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
  });

  const conversionTimeLabel = createMemo(() => {
    if (typeof local.conversionDurationSeconds !== 'number') return null;
    return formatDurationSeconds(local.conversionDurationSeconds, locale());
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
    // Sanitize path separators and control characters to prevent directory traversal
    const sanitized = safeBaseName
      .replace(/\.\.+/g, '_')
      .replace(/[/\\]/g, '_')
      .replace(/[\x00-\x1f\x7f]/g, '');
    return `${sanitized || 'converted'}.${outputExtension()}`;
  });

  const ariaLabel = createMemo(
    () =>
      `${outputExtension().toUpperCase()} conversion results: ${downloadFileName()}, ${formatBytes(local.outputBlob.size, locale())}`
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
    const pct = Math.abs(ratio).toFixed(0);
    if (ratio > 0) return t('result.compressionSmaller', { percent: pct });
    return t('result.compressionLarger', { percent: pct });
  });

  const compressionColorClass = createMemo(() => {
    const ratio = compressionRatio();
    if (ratio === null) return '';
    if (ratio > 50) return 'text-green-400';
    if (ratio > 0) return 'text-green-500';
    return 'text-orange-400';
  });

  const handlePreviewLoad = () => setLoaded(true);
  const handlePreviewError = () => {
    setPreviewError(true);
    setLoaded(true);
  };

  return (
    <Panel class="p-4 bg-[#0f1011] border border-white/[0.08] rounded-lg">
      {/* Preview area */}
      <div class="relative flex justify-center bg-white/[0.02] rounded-lg overflow-hidden">
        {/* Skeleton: removed from DOM when loaded */}
        <Show when={!loaded()}>
          <div class="w-full aspect-video bg-white/[0.05] animate-pulse rounded" />
        </Show>
        <Show when={previewUrl()}>
          <img
            src={previewUrl()!}
            alt={`${outputExtension().toUpperCase()} preview: ${downloadFileName()}`}
            class="w-full h-auto max-h-[70vh] object-contain rounded transition-opacity duration-300 opacity-100"
            onLoad={handlePreviewLoad}
            onError={handlePreviewError}
            data-testid="result-image"
          />
        </Show>
        <Show when={previewError()}>
          <div class="flex flex-col items-center justify-center p-8 text-[#8a8f98] w-full">
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
            <span class="text-xs">{t('result.previewFailed')}</span>
          </div>
        </Show>
      </div>

      {/* Stats */}
      <section class="mt-3" aria-label={ariaLabel()}>
        {/* Primary stats: size reduction + time */}
        <div class="flex items-center justify-center gap-3 text-sm mb-2">
          <span class="text-[#8a8f98] font-mono" data-result-original-size>
            {formatBytes(local.originalSize, locale())}
          </span>
          <svg
            class="h-4 w-4 text-[#5e6ad2]/60"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M13 7l5 5m0 0l-5 5m5-5H6"
            />
          </svg>
          <span class="font-semibold text-[#d0d6e0] font-mono" data-result-output-size>
            {formatBytes(local.outputBlob.size, locale())}
          </span>
          <Show when={compressionLabel()}>
            <span class={`font-semibold ${compressionColorClass()}`}>{compressionLabel()}</span>
          </Show>
          <Show when={conversionTimeLabel()}>
            <span class="text-[#5e6ad2]/60">·</span>
            <span class="text-[#8a8f98]">⚡ {conversionTimeLabel()}</span>
          </Show>
        </div>

        {/* Secondary stats: format, quality, scale */}
        <div class="flex items-center justify-center gap-2 text-[10px] text-[#5e6ad2]/70 uppercase tracking-wide">
          <span data-result-format>{outputExtension().toUpperCase()}</span>
          <span>·</span>
          <span class="capitalize" data-result-quality>
            {local.settings.quality}
          </span>
          <span>·</span>
          <span data-result-scale>
            {(local.settings.scale * SCALE_PERCENTAGE_MULTIPLIER).toFixed(0)}%
          </span>
        </div>
      </section>

      {/* Download button */}
      <div class="mt-3 flex justify-center">
        <a
          href={downloadUrl() ?? undefined}
          download={downloadFileName()}
          aria-label={t('result.downloadFile', {
            format: outputExtension().toUpperCase(),
            fileName: downloadFileName(),
          })}
          class="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[#5e6ad2] text-white text-sm font-medium shadow-lg hover:bg-[#7e8ae8] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5e6ad2]"
          data-testid="download-result-button"
          role="button"
        >
          <svg
            class="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
          {t('result.downloadButton', {
            format: outputExtension().toUpperCase(),
            size: formatBytes(local.outputBlob.size, locale()),
          })}
        </a>
      </div>
    </Panel>
  );
};

export default ResultPreview;
