// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import RecoveryResultDownload from '@components/RecoveryResultDownload';
import { appState } from '@stores/conversion-store';
import type { ConversionResult } from '@t/conversion-types';
import type { TFunction } from '@t/i18n-types';
import { logger } from '@utils/logger';
import type { Component } from 'solid-js';
import { onMount, Show } from 'solid-js';
import { assetFailure } from '@/asset-recovery';
import { canReload, reloadWhenSafe } from '@/reload-protection';

/** Vite replaces this with the clean source SHA; unknown local builds receive null. */
declare const __APP_SOURCE_SHA__: string | null;

interface AppErrorFallbackProps {
  error: unknown;
  reset: () => void;
  t: TFunction;
  busy: boolean;
  cancelling: boolean;
  results: ConversionResult[];
  onCancel: () => void;
  onClearResults: () => void;
}

const AppErrorFallback: Component<AppErrorFallbackProps> = (props) => {
  onMount(() => {
    logger.warn('general', 'app.feature-render-failed', {
      kind: 'render',
      sourceSha: typeof __APP_SOURCE_SHA__ === 'undefined' ? null : __APP_SOURCE_SHA__,
      operation: appState(),
      online: navigator.onLine,
      swControlled: Boolean(navigator.serviceWorker?.controller),
      hasResults: props.results.length > 0,
      assetPath: assetFailure()?.path ?? null,
      assetStatus: assetFailure()?.status ?? null,
      errorName:
        props.error instanceof TypeError
          ? 'TypeError'
          : props.error instanceof ReferenceError
            ? 'ReferenceError'
            : props.error instanceof Error
              ? 'Error'
              : 'unknown',
    });
  });
  return (
    <div class="flex items-center justify-center bg-bg-base p-4" data-testid="app-error-fallback">
      <div class="max-w-2xl border-l-4 border-status-danger/60 bg-bg-elevated p-6 rounded-lg">
        <h2 class="mb-2 text-lg font-semibold text-text-primary">{props.t('app.error.title')}</h2>
        <p class="mb-4 text-sm text-text-secondary">{props.t('app.error.description')}</p>
        <Show when={props.busy}>
          <p class="mb-3 text-sm text-text-secondary">{props.t('update.wait')}</p>
          <button
            type="button"
            disabled={props.cancelling}
            onClick={() => {
              if (props.busy && !props.cancelling) props.onCancel();
            }}
            class="mb-3 rounded-md border border-border-standard px-4 py-2 text-sm disabled:opacity-50"
            data-testid="recovery-cancel"
          >
            {props.t(props.cancelling ? 'progress.cancelling' : 'dropzone.cancel')}
          </button>
        </Show>
        <Show when={props.results.length > 0}>
          <p class="mb-3 text-sm text-text-secondary">{props.t('update.download')}</p>
          <div class="mb-3 flex flex-wrap gap-2">
            <RecoveryResultDownload results={props.results} t={props.t} />
          </div>
          <button
            type="button"
            disabled={props.busy}
            onClick={() => {
              if (!props.busy && props.results.length > 0) props.onClearResults();
            }}
            class="mb-3 rounded-md border border-border-standard px-4 py-2 text-sm disabled:opacity-50"
            data-testid="recovery-clear-results"
          >
            {props.t('update.clearResults')}
          </button>
        </Show>
        <div class="mb-4 flex gap-3">
          <Show
            when={
              !/Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Failed to load a module script|non-JavaScript MIME type|Unable to preload CSS/i.test(
                String(props.error)
              )
            }
          >
            <button
              type="button"
              disabled={props.busy}
              onClick={() => {
                if (!props.busy) props.reset();
              }}
              class="inline-flex items-center rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground disabled:opacity-50"
            >
              {props.t('app.error.retry')}
            </button>
          </Show>
          <button
            type="button"
            disabled={!canReload(props.busy, props.results.length > 0)}
            onClick={() =>
              reloadWhenSafe(
                () => props.busy,
                () => props.results.length > 0
              )
            }
            class="inline-flex items-center rounded-md border border-border-standard bg-white/[0.02] px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/[0.2] focus-visible:ring-offset-2 focus-visible:ring-offset-bg-elevated cursor-pointer"
            data-testid="recovery-reload"
          >
            {props.t('app.error.reload')}
          </button>
        </div>
        <details class="text-xs text-text-secondary">
          <summary class="cursor-pointer hover:underline">{props.t('app.error.details')}</summary>
          <pre class="mt-2 overflow-auto rounded bg-white/[0.02] border border-border-standard p-3">
            {String(props.error)}
          </pre>
        </details>
      </div>
    </div>
  );
};

export default AppErrorFallback;
