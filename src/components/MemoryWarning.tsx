// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { Component } from 'solid-js';
import { createMemo, Show, splitProps } from 'solid-js';

interface MemoryWarningProps {
  isDuringConversion: boolean;
  onReduceSettings?: () => void;
  onCancel?: () => void;
  onDismiss?: () => void;
}

const MemoryWarning: Component<MemoryWarningProps> = (props) => {
  const { t } = useLocale();
  const [local] = splitProps(props, [
    'isDuringConversion',
    'onReduceSettings',
    'onCancel',
    'onDismiss',
  ]);

  const warningTitle = createMemo(() =>
    local.isDuringConversion ? t('memory.titleActive') : t('memory.title')
  );

  const warningMessage = createMemo(() =>
    local.isDuringConversion ? t('memory.descriptionActive') : t('memory.description')
  );

  const handleReduceSettings = () => local.onReduceSettings?.();
  const handleCancel = () => local.onCancel?.();
  const handleDismiss = () => local.onDismiss?.();

  return (
    <div
      class="bg-[#191a1b] border-l-4 border-amber-500/60 rounded-lg p-4"
      role="alert"
      aria-live="polite"
      aria-atomic="true"
      data-testid="memory-warning"
    >
      <div class="flex items-start">
        <div class="flex-shrink-0">
          <svg
            class="h-5 w-5 text-amber-500"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fill-rule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clip-rule="evenodd"
            />
          </svg>
        </div>
        <div class="ml-3 flex-1">
          <h3 class="text-sm font-medium text-[#f7f8f8]">{warningTitle()}</h3>
          <div class="mt-2 text-sm text-[#d0d6e0]">
            <p>{warningMessage()}</p>
            <Show when={!local.isDuringConversion}>
              <p class="mt-2">
                <strong class="text-[#f7f8f8]">Recommendation:</strong> Close other browser tabs
                before starting conversion, or use lower quality settings.
              </p>
            </Show>
          </div>

          <div class="mt-4 flex flex-wrap gap-3">
            <Show
              when={local.isDuringConversion}
              fallback={
                <>
                  <Show when={local.onDismiss}>
                    <button
                      type="button"
                      onClick={handleDismiss}
                      class="inline-flex items-center px-3 py-2 text-sm leading-4 font-medium rounded-md text-[#d0d6e0] bg-white/[0.02] border border-white/[0.08] hover:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-500"
                      aria-label={t('memory.cancelRetry')}
                      data-testid="memory-warning-dismiss"
                    >
                      {t('memory.dismiss')}
                    </button>
                  </Show>
                  <Show when={local.onReduceSettings}>
                    <button
                      type="button"
                      onClick={handleReduceSettings}
                      class="inline-flex items-center px-3 py-2 text-sm leading-4 font-medium rounded-md text-[#f7f8f8] bg-white/[0.02] border border-white/[0.08] hover:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-500"
                      aria-label={t('memory.reduceStart')}
                      data-testid="memory-warning-reduce"
                    >
                      {t('memory.reduceStart')}
                    </button>
                  </Show>
                </>
              }
            >
              <Show when={local.onCancel}>
                <button
                  type="button"
                  onClick={handleCancel}
                  class="inline-flex items-center px-3 py-2 text-sm leading-4 font-medium rounded-md text-[#f7f8f8] bg-white/[0.02] border border-white/[0.08] hover:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-500"
                  aria-label={t('memory.cancel')}
                  data-testid="memory-warning-cancel"
                >
                  {t('memory.cancel')}
                </button>
              </Show>
              <Show when={local.onDismiss}>
                <button
                  type="button"
                  onClick={handleDismiss}
                  class="inline-flex items-center px-3 py-2 text-sm leading-4 font-medium rounded-md text-[#d0d6e0] bg-white/[0.02] border border-white/[0.08] hover:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-500"
                  aria-label={t('memory.dismiss')}
                  data-testid="memory-warning-continue"
                >
                  {t('memory.dismiss')}
                </button>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MemoryWarning;
