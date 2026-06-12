// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import EnvironmentWarning from '@components/EnvironmentWarning';
import OfflineBanner from '@components/OfflineBanner';
import type { ErrorContext } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { lazy, Show, Suspense, splitProps } from 'solid-js';

const ErrorDisplay = lazy(() => import('@components/ErrorDisplay'));

interface StatusAlertsProps {
  environmentSupported: boolean;
  errorMessage: string | null;
  errorContext: ErrorContext | null;
  onRetry: () => void;
  onSelectNewFile: () => void;
  onDismissError: () => void;
}

const StatusAlerts: Component<StatusAlertsProps> = (props) => {
  const [local] = splitProps(props, [
    'environmentSupported',
    'errorMessage',
    'errorContext',
    'onRetry',
    'onSelectNewFile',
    'onDismissError',
  ]);
  return (
    <div class="space-y-6" data-testid="status-alerts">
      <OfflineBanner />

      <Show when={!local.environmentSupported}>
        <EnvironmentWarning />
      </Show>

      <Show when={local.errorMessage}>
        <Suspense
          fallback={<div class="h-32 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />}
        >
          <ErrorDisplay
            message={local.errorMessage!}
            suggestion={local.errorContext?.suggestion}
            errorType={local.errorContext?.type}
            onRetry={local.onRetry}
            onSelectNewFile={local.onSelectNewFile}
            onDismiss={local.onDismissError}
          />
        </Suspense>
      </Show>
    </div>
  );
};

export default StatusAlerts;
