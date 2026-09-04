// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import Panel from '@components/ui/Panel';
import { useLocale } from '@hooks/use-locale';
import type { ConversionErrorType } from '@t/conversion-types';
import type { TranslationKey } from '@t/i18n-types';
import type { Component } from 'solid-js';
import { createMemo, onMount, Show, splitProps } from 'solid-js';

const ERROR_ICONS: Partial<Record<ConversionErrorType, string>> = {
  memory: '💾',
  format: '📁',
  codec: '📁',
};

interface ErrorDisplayProps {
  message: string;
  suggestion?: string | undefined;
  errorType?: ConversionErrorType | undefined;
  onRetry: () => void;
  onSelectNewFile: () => void;
  onDismiss?: (() => void) | undefined;
}

const ErrorDisplay: Component<ErrorDisplayProps> = (props) => {
  const { t } = useLocale();
  const [local] = splitProps(props, [
    'message',
    'suggestion',
    'errorType',
    'onRetry',
    'onSelectNewFile',
    'onDismiss',
  ]);
  let primaryActionRef: HTMLButtonElement | undefined;

  onMount(() => {
    queueMicrotask(() => {
      primaryActionRef?.focus();
    });
  });

  const canRetry = createMemo(() => local.errorType !== 'format' && local.errorType !== 'codec');

  const userFriendlyMessage = createMemo((): string => {
    if (!local.errorType || local.errorType === 'general') {
      return t('error.unknown');
    }

    const key = `error.${local.errorType}` as TranslationKey;
    return t(key);
  });

  const errorIcon = createMemo(() => ERROR_ICONS[local.errorType ?? 'general'] ?? '');

  const rawErrorMessage = createMemo(() => {
    if (!local.errorType || local.errorType === 'general') {
      return local.message;
    }
    return null;
  });

  const handleDismiss = () => local.onDismiss?.();
  const handleRetry = () => local.onRetry();
  const handleSelectNewFile = () => local.onSelectNewFile();

  return (
    <Panel
      class="relative border-l-4 border-status-danger/60 p-4 bg-bg-elevated rounded-lg"
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      data-testid="error-display"
    >
      <Show when={local.onDismiss}>
        <button
          type="button"
          onClick={handleDismiss}
          class="absolute top-4 right-4 p-2 text-text-secondary hover:text-text-primary transition-colors rounded-md hover:bg-bg-elevated/50 cursor-pointer"
          aria-label={t('error.dismiss')}
          data-testid="error-dismiss-button"
        >
          <svg
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </Show>
      <div class="flex">
        <div class="flex-shrink-0">
          <svg
            class="h-5 w-5 text-status-danger"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clip-rule="evenodd"
            />
          </svg>
        </div>
        <div class="ml-3 flex-1">
          <h3 class="text-sm font-medium text-text-primary">
            {t('error.conversionFailed')}{' '}
            {errorIcon() && (
              <span class="ml-1" aria-hidden="true">
                {errorIcon()}
              </span>
            )}
          </h3>
          <p class="mt-2 text-sm text-text-secondary">{userFriendlyMessage()}</p>
          <Show when={rawErrorMessage()}>
            <details class="mt-2">
              <summary class="text-xs text-text-secondary cursor-pointer hover:underline">
                {t('error.technicalDetails')}
              </summary>
              <pre class="mt-1 text-xs text-text-secondary whitespace-pre-wrap break-all bg-white/[0.02] border border-border-standard p-2 rounded max-h-32 overflow-auto">
                {rawErrorMessage()}
              </pre>
            </details>
          </Show>
          <Show when={local.suggestion}>
            <div class="mt-2 p-3 bg-white/[0.02] border border-border-standard rounded text-sm text-text-secondary">
              <strong class="text-text-primary">{t('error.suggestion')}</strong> {local.suggestion}
            </div>
          </Show>
          <div class="mt-4 flex gap-3">
            <Show
              when={canRetry()}
              fallback={
                <button
                  ref={primaryActionRef}
                  type="button"
                  data-testid="error-select-different-fallback-button"
                  class="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-text-primary bg-white/[0.02] border-border-standard hover:bg-bg-elevated/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-focus cursor-pointer"
                  onClick={handleSelectNewFile}
                  aria-label={t('error.selectDifferent')}
                >
                  {t('error.selectDifferentFallback')}
                </button>
              }
            >
              <button
                ref={primaryActionRef}
                type="button"
                data-testid="error-retry-button"
                class="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-text-primary bg-white/[0.02] border-border-standard hover:bg-bg-elevated/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-focus cursor-pointer"
                onClick={handleRetry}
                aria-label={t('error.retry')}
              >
                {t('error.retry')}
              </button>
              <button
                type="button"
                data-testid="error-select-different-button"
                class="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md text-text-secondary bg-white/[0.02] border-border-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-focus cursor-pointer"
                onClick={handleSelectNewFile}
                aria-label={t('error.selectDifferent')}
              >
                {t('error.selectDifferent')}
              </button>
            </Show>
          </div>
        </div>
      </div>
    </Panel>
  );
};

export default ErrorDisplay;
