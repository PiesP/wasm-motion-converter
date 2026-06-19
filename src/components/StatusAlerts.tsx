// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import EnvironmentWarning from '@components/EnvironmentWarning';
import OfflineBanner from '@components/OfflineBanner';
import type { ErrorContext } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { lazy, Show, Suspense } from 'solid-js';

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
  return (
    <div class="space-y-6" data-testid="status-alerts">
      <OfflineBanner />

      <Show when={!props.environmentSupported}>
        <EnvironmentWarning />
      </Show>

      <Show when={props.errorMessage}>
        <Suspense fallback={<div class="h-32 animate-pulse rounded-lg bg-[#191a1b]" />}>
          <ErrorDisplay
            message={props.errorMessage!}
            suggestion={props.errorContext?.suggestion}
            errorType={props.errorContext?.type}
            onRetry={props.onRetry}
            onSelectNewFile={props.onSelectNewFile}
            onDismiss={props.onDismissError}
          />
        </Suspense>
      </Show>
    </div>
  );
};

export default StatusAlerts;
