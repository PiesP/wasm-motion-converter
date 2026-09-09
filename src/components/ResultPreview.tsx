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
  outputWidth: number;
  outputHeight: number;
  settings: ConversionSettings;
  conversionDurationSeconds?: number | undefined;
}

type PreviewSizeMode = 'actual' | 'fit';

const ResultPreview: Component<ResultPreviewProps> = (props) => {
  const { t, locale } = useLocale();
  const [local] = splitProps(props, [
    'outputBlob',
    'originalName',
    'originalSize',
    'outputWidth',
    'outputHeight',
    'settings',
    'conversionDurationSeconds',
  ]);
  const [loaded, setLoaded] = createSignal(false);
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
  const [downloadUrl, setDownloadUrl] = createSignal<string | null>(null);
  const [previewError, setPreviewError] = createSignal(false);
  const [previewSizeMode, setPreviewSizeMode] = createSignal<PreviewSizeMode>('actual');
  const [actualWidth, setActualWidth] = createSignal(local.outputWidth);
  const [actualHeight, setActualHeight] = createSignal(local.outputHeight);
  const [renderedScalePercent, setRenderedScalePercent] = createSignal<number | null>(null);
  let downloadButtonRef: HTMLAnchorElement | undefined;
  let resultImageRef: HTMLImageElement | undefined;
  let previewResizeObserver: ResizeObserver | undefined;
  let pendingResultScrollFrame: number | undefined;

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
    setPreviewSizeMode('actual');
    setActualWidth(local.outputWidth);
    setActualHeight(local.outputHeight);
    setRenderedScalePercent(null);
    previewResizeObserver?.disconnect();
    previewResizeObserver = undefined;

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
    if (pendingResultScrollFrame !== undefined) {
      cancelAnimationFrame(pendingResultScrollFrame);
      pendingResultScrollFrame = undefined;
    }
    previewResizeObserver?.disconnect();
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

  const ariaLabel = createMemo(() =>
    t('result.aria.sectionLabel', {
      format: outputExtension().toUpperCase(),
      name: downloadFileName(),
      size: formatBytes(local.outputBlob.size, locale()),
    })
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
    if (ratio > 0) return 'text-status-success';
    return 'text-status-warning';
  });

  const updateRenderedScale = (): void => {
    const image = resultImageRef;
    if (!image || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    setRenderedScalePercent(Math.round(scale * SCALE_PERCENTAGE_MULTIPLIER));
  };

  const selectPreviewSize = (mode: PreviewSizeMode): void => {
    setPreviewSizeMode(mode);
    queueMicrotask(updateRenderedScale);
  };

  const keepFocusedDownloadVisible = (): void => {
    const downloadButton = downloadButtonRef;
    if (!downloadButton || document.activeElement !== downloadButton) return;

    if (pendingResultScrollFrame !== undefined) {
      cancelAnimationFrame(pendingResultScrollFrame);
    }
    pendingResultScrollFrame = requestAnimationFrame(() => {
      pendingResultScrollFrame = undefined;
      if (!downloadButton.isConnected || document.activeElement !== downloadButton) return;
      downloadButton.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  };

  const handlePreviewLoad = (event: Event) => {
    const image = event.currentTarget as HTMLImageElement;
    resultImageRef = image;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      setActualWidth(image.naturalWidth);
      setActualHeight(image.naturalHeight);
    }
    setLoaded(true);
    updateRenderedScale();
    if (typeof ResizeObserver !== 'undefined') {
      previewResizeObserver?.disconnect();
      previewResizeObserver = new ResizeObserver(updateRenderedScale);
      previewResizeObserver.observe(image);
    }
    keepFocusedDownloadVisible();
  };
  const handlePreviewError = () => {
    setPreviewError(true);
    setLoaded(true);
    keepFocusedDownloadVisible();
  };

  return (
    <Panel class="p-4 bg-bg-panel border border-border-standard rounded-lg result-preview-deferred">
      <section aria-label={ariaLabel()}>
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <dl
            class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary"
            data-testid="result-summary"
          >
            <div>
              <dt class="sr-only">{t('result.format')}</dt>
              <dd class="font-semibold" data-result-format>
                {outputExtension().toUpperCase()}
              </dd>
            </div>
            <div>
              <dt class="sr-only">{t('result.resolution')}</dt>
              <dd class="font-mono" data-result-resolution>
                {actualWidth()}×{actualHeight()}
              </dd>
            </div>
            <div>
              <dt class="sr-only">{t('result.outputSize')}</dt>
              <dd class="font-mono" data-result-output-size>
                {formatBytes(local.outputBlob.size, locale())}
              </dd>
            </div>
          </dl>

          <a
            ref={downloadButtonRef}
            href={downloadUrl() ?? undefined}
            download={downloadFileName()}
            aria-label={t('result.downloadFile', {
              format: outputExtension().toUpperCase(),
              fileName: downloadFileName(),
            })}
            class="inline-flex min-h-target-minimum shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-button bg-brand px-4 py-2 text-sm font-medium text-brand-foreground shadow-lg transition-colors hover:bg-brand-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            data-testid="download-result-button"
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
      </section>

      <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
        <fieldset class="inline-flex rounded-button border border-border-standard bg-white/[0.02] p-0.5">
          <legend class="sr-only">{t('result.previewSize')}</legend>
          <button
            type="button"
            class={`min-h-target-minimum rounded-button px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              previewSizeMode() === 'actual'
                ? 'bg-bg-elevated text-text-primary'
                : 'text-text-secondary hover:bg-white/[0.05]'
            }`}
            aria-pressed={previewSizeMode() === 'actual'}
            onClick={() => selectPreviewSize('actual')}
            data-testid="preview-size-actual"
          >
            {t('result.actualSize')}
          </button>
          <button
            type="button"
            class={`min-h-target-minimum rounded-button px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              previewSizeMode() === 'fit'
                ? 'bg-bg-elevated text-text-primary'
                : 'text-text-secondary hover:bg-white/[0.05]'
            }`}
            aria-pressed={previewSizeMode() === 'fit'}
            onClick={() => selectPreviewSize('fit')}
            data-testid="preview-size-fit"
          >
            {t('result.fitToArea')}
          </button>
        </fieldset>
        <Show when={renderedScalePercent()}>
          {(scale) => (
            <span
              class="text-xs tabular-nums text-text-secondary"
              data-preview-scale={`${scale()}%`}
              data-testid="preview-scale"
            >
              {t('result.previewScale', { percent: scale() })}
            </span>
          )}
        </Show>
      </div>

      {/* Preview area */}
      <div class="relative mt-2 grid min-h-20 place-items-center overflow-hidden rounded-lg bg-white/[0.02]">
        {/* Skeleton: removed from DOM when loaded */}
        <Show when={!loaded()}>
          <div
            class="col-start-1 row-start-1 max-h-[70vh] max-w-full animate-pulse rounded bg-white/[0.05]"
            style={{
              width: previewSizeMode() === 'fit' ? '100%' : `${actualWidth()}px`,
              'aspect-ratio': `${actualWidth()} / ${actualHeight()}`,
            }}
          />
        </Show>
        <Show when={previewUrl()}>
          <img
            ref={(element) => {
              resultImageRef = element;
            }}
            src={previewUrl()!}
            alt={t('result.aria.previewAlt', {
              format: outputExtension().toUpperCase(),
              name: downloadFileName(),
            })}
            aria-label={t('result.aria.previewAlt', {
              format: outputExtension().toUpperCase(),
              name: downloadFileName(),
            })}
            class={`col-start-1 row-start-1 block h-auto max-h-[70vh] justify-self-center rounded object-contain opacity-100 transition-opacity duration-300 ${
              previewSizeMode() === 'fit' ? 'w-full' : 'w-auto max-w-full'
            }`}
            onLoad={handlePreviewLoad}
            onError={handlePreviewError}
            data-testid="result-image"
          />
        </Show>
        <Show when={previewError()}>
          <div class="flex flex-col items-center justify-center p-8 text-text-tertiary w-full">
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

      {/* Detailed stats */}
      <section class="mt-3" aria-label={t('result.details')}>
        <div class="flex items-center justify-center gap-3 text-sm mb-2">
          <span class="text-text-tertiary font-mono" data-result-original-size>
            {formatBytes(local.originalSize, locale())}
          </span>
          <svg
            class="h-4 w-4 text-text-tertiary"
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
          <span class="font-semibold text-text-secondary font-mono" data-result-detail-output-size>
            {formatBytes(local.outputBlob.size, locale())}
          </span>
          <Show when={compressionLabel()}>
            <span class={`font-semibold ${compressionColorClass()}`}>{compressionLabel()}</span>
          </Show>
          <Show when={conversionTimeLabel()}>
            <span class="text-text-tertiary" aria-hidden="true">
              ·
            </span>
            <span class="text-text-tertiary" data-testid="conversion-time">
              ⚡ {conversionTimeLabel()}
            </span>
          </Show>
        </div>

        <dl class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-text-secondary">
          <div class="flex items-center gap-1">
            <dt>{t('result.quality')}</dt>
            <dd class="capitalize" data-result-quality>
              {local.settings.quality}
            </dd>
          </div>
          <div class="flex items-center gap-1">
            <dt>{t('result.scale')}</dt>
            <dd data-result-scale>
              {(local.settings.scale * SCALE_PERCENTAGE_MULTIPLIER).toFixed(0)}%
            </dd>
          </div>
        </dl>
      </section>
    </Panel>
  );
};

export default ResultPreview;
