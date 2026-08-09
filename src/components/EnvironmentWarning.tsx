// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import { assessEnvironmentCapabilities } from '@utils/environment-capabilities';
import { logger } from '@utils/logger';
import type { Component } from 'solid-js';
import { createMemo, createSignal, onMount, Show } from 'solid-js';

const STORAGE_KEY = 'envWarningExpanded';

const EnvironmentWarning: Component = () => {
  const { t } = useLocale();
  const [isExpanded, setIsExpanded] = createSignal(true);

  const capabilities = createMemo(() => assessEnvironmentCapabilities());

  onMount(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved !== null) {
        setIsExpanded(saved === 'true');
      }
    } catch (error) {
      logger.warn('general', 'Failed to load environment warning state', { error });
    }
  });

  const persistExpandedState = (nextValue: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(nextValue));
    } catch (error) {
      logger.warn('general', 'Failed to save environment warning state', { error });
    }
  };

  const handleToggleExpanded = () => {
    setIsExpanded((current) => {
      const nextValue = !current;
      persistExpandedState(nextValue);
      return nextValue;
    });
  };

  const handleTestEnvironment = () => {
    logger.warn('general', 'Environment test results', {
      ...capabilities(),
    });
  };

  const capabilityLabel = (available: boolean) =>
    available ? t('env.available') : t('env.unavailable');

  return (
    <div
      class="bg-bg-elevated border-l-4 border-status-warning/60 p-4"
      role="alert"
      aria-live="polite"
      data-testid="environment-warning"
    >
      <div class="flex">
        <div class="flex-shrink-0">
          <svg
            class="h-5 w-5 text-status-warning/60"
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
          <div class="flex items-start justify-between">
            <h3 class="text-sm font-medium text-text-primary">{t('env.notSupported')}</h3>
            <button
              type="button"
              onClick={handleToggleExpanded}
              class="ml-3 text-sm text-text-secondary hover:text-text-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 rounded cursor-pointer"
              aria-expanded={isExpanded()}
              aria-label={isExpanded() ? t('env.hideDetails') : t('env.showDetails')}
            >
              {isExpanded() ? t('env.hideDetails') : t('env.showDetails')}
            </button>
          </div>

          <Show when={isExpanded()}>
            <div class="mt-2 text-sm text-text-secondary">
              <Show when={!capabilities().hasWebCodecs}>
                <p>{t('env.webCodecsUnavailable')}</p>
              </Show>
              <Show when={!capabilities().hasWebAssembly}>
                <p>{t('env.webAssemblyUnavailable')}</p>
              </Show>
              <p class="mt-2">
                {t('env.detected', {
                  webCodecs: capabilityLabel(capabilities().hasWebCodecs),
                  webAssembly: capabilityLabel(capabilities().hasWebAssembly),
                })}
              </p>
              <p class="mt-2">
                <strong>{t('env.localDevHint')}</strong>
              </p>
              <p class="mt-2">
                <strong>{t('env.deployedHint')}</strong>
              </p>
            </div>
            <div class="mt-3">
              <button
                type="button"
                onClick={handleTestEnvironment}
                class="inline-flex items-center px-3 py-1.5 border border-border-standard text-sm font-medium rounded text-text-secondary bg-white/[0.02] hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 cursor-pointer"
                aria-label={t('env.logCapabilities')}
              >
                {t('env.logCapabilities')}
              </button>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default EnvironmentWarning;
