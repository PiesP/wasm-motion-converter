// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import EnvironmentWarning from '@components/EnvironmentWarning';
import ErrorDisplay from '@components/ErrorDisplay';
import OfflineBanner from '@components/OfflineBanner';
import type { ConversionSettingsPersistenceStatus } from '@stores/conversion-settings-store';
import type { ErrorContext } from '@t/conversion-types';
import type { TFunction } from '@t/i18n-types';
import type { Component } from 'solid-js';
import { Show } from 'solid-js';

interface StatusAlertsProps {
  t: TFunction;
  persistenceStatus?: ConversionSettingsPersistenceStatus;
  environmentSupported: boolean;
  errorMessage: string | null;
  errorContext: ErrorContext | null;
  canRetry?: boolean | undefined;
  onRetry: () => void;
  onSelectNewFile: () => void;
  onDismissError: () => void;
}

const StatusAlerts: Component<StatusAlertsProps> = (props) => {
  return (
    <div class="space-y-6" data-testid="status-alerts">
      <OfflineBanner />

      <Show when={props.persistenceStatus && props.persistenceStatus !== 'writable'}>
        <div
          class="rounded-lg bg-status-warning text-bg-base px-4 py-2 text-center font-medium"
          role="status"
          data-testid="settings-persistence-notice"
        >
          {props.t(
            props.persistenceStatus === 'future'
              ? 'settings.persistenceFuture'
              : 'settings.persistenceUnavailable'
          )}
        </div>
      </Show>

      <Show when={!props.environmentSupported}>
        <EnvironmentWarning />
      </Show>

      <Show when={props.errorMessage}>
        <ErrorDisplay
          message={props.errorMessage!}
          suggestion={props.errorContext?.suggestion}
          errorType={props.errorContext?.type}
          canRetry={props.canRetry}
          reloadRequired={props.errorContext?.phase === 'wasm_webp_initialization'}
          onRetry={props.onRetry}
          onSelectNewFile={props.onSelectNewFile}
          onDismiss={props.onDismissError}
        />
      </Show>
    </div>
  );
};

export default StatusAlerts;
