// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import Panel from '@components/ui/Panel';
import type { ConversionErrorType } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { createMemo, onMount, Show, splitProps } from 'solid-js';

const ERROR_MESSAGES: Record<ConversionErrorType, string> = {
  format: 'This video format is not supported. Please try a different file.',
  codec: 'This video codec cannot be processed. Please try a different file.',
  timeout: 'The conversion took too long. Try a shorter video or lower quality settings.',
  memory: 'Ran out of memory. Close other browser tabs or use lower quality settings.',
  general: '',
};

const ERROR_ICONS: Partial<Record<ConversionErrorType, string>> = {
  memory: '💾',
  format: '📁',
  codec: '📁',
};

interface ErrorDisplayProps {
  message: string;
  suggestion?: string;
  errorType?: ConversionErrorType;
  onRetry: () => void;
  onSelectNewFile: () => void;
  onDismiss?: () => void;
}

const ErrorDisplay: Component<ErrorDisplayProps> = (props) => {
  const [local] = splitProps(props, [
    'message',
    'suggestion',
    'errorType',
    'onRetry',
    'onSelectNewFile',
    'onDismiss',
  ]);
  let retryButtonRef: HTMLButtonElement | undefined;

  onMount(() => {
    queueMicrotask(() => {
      retryButtonRef?.focus();
    });
  });

  const canRetry = createMemo(() => local.errorType !== 'format' && local.errorType !== 'codec');

  const userFriendlyMessage = createMemo(() => {
    if (!local.errorType || local.errorType === 'general') {
      return 'Conversion failed unexpectedly';
    }

    return ERROR_MESSAGES[local.errorType] ?? local.message;
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
      class="relative border-l-4 border-red-500/60 p-4 bg-[#191a1b] rounded-lg"
      role="alert"
      ariaLive="assertive"
      data-testid="error-display"
    >
      <Show when={local.onDismiss}>
        <button
          type="button"
          onClick={handleDismiss}
          class="absolute top-4 right-4 p-2 text-[#d0d6e0] hover:text-[#f7f8f8] transition-colors rounded-md hover:bg-white/[0.05]"
          aria-label="Dismiss error message"
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
            class="h-5 w-5 text-red-500"
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
          <h3 class="text-sm font-medium text-[#f7f8f8]">
            Conversion Failed{' '}
            {errorIcon() && (
              <span class="ml-1" aria-hidden="true">
                {errorIcon()}
              </span>
            )}
          </h3>
          <p class="mt-2 text-sm text-[#d0d6e0]">{userFriendlyMessage()}</p>
          <Show when={rawErrorMessage()}>
            <details class="mt-2">
              <summary class="text-xs text-[#d0d6e0] cursor-pointer hover:underline">
                Technical details
              </summary>
              <pre class="mt-1 text-xs text-[#d0d6e0] whitespace-pre-wrap break-all bg-white/[0.02] border border-white/[0.08] p-2 rounded max-h-32 overflow-auto">
                {rawErrorMessage()}
              </pre>
            </details>
          </Show>
          <Show when={local.suggestion}>
            <div class="mt-2 p-3 bg-white/[0.02] border border-white/[0.08] rounded text-sm text-[#d0d6e0]">
              <strong class="text-[#f7f8f8]">Suggestion:</strong> {local.suggestion}
            </div>
          </Show>
          <div class="mt-4 flex gap-3">
            <Show
              when={canRetry()}
              fallback={
                <button
                  type="button"
                  data-testid="error-select-different-fallback-button"
                  class="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-[#f7f8f8] bg-white/[0.02] border border-white/[0.08] hover:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                  onClick={handleSelectNewFile}
                  aria-label="Select a different video file to convert"
                >
                  Select Different File
                </button>
              }
            >
              <button
                ref={retryButtonRef}
                type="button"
                data-testid="error-retry-button"
                class="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-[#f7f8f8] bg-white/[0.02] border border-white/[0.08] hover:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                onClick={handleRetry}
                aria-label="Retry conversion with the same file"
              >
                Retry with Same File
              </button>
              <button
                type="button"
                data-testid="error-select-different-button"
                class="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md text-[#d0d6e0] bg-white/[0.02] border border-white/[0.08] hover:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                onClick={handleSelectNewFile}
                aria-label="Select a different video file to convert"
              >
                Select Different File
              </button>
            </Show>
          </div>
        </div>
      </div>
    </Panel>
  );
};

export default ErrorDisplay;
