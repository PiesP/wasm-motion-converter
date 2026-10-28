// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import AppUpdateNotice from '@components/AppUpdateNotice';
import StatusAlerts from '@components/StatusAlerts';
import type { ConversionErrorType, ErrorContext } from '@t/conversion-types';
import { focusPrimaryErrorAction } from '@utils/dom-utils';
import { batch, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { clearAssetFailure } from '@/asset-recovery';

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

const deployment = vi.hoisted(() => ({ onUpdate: () => {} }));
vi.mock('@/deployment-update', () => ({
  observeDeploymentUpdates: (options: { onUpdate: () => void }) => {
    deployment.onUpdate = options.onUpdate;
    return () => {};
  },
}));
vi.mock('@/sw-register', () => ({
  registerServiceWorker: async () => ({ cleanup: () => {} }),
}));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  clearAssetFailure();
  document.body.replaceChildren();
});

function mountAlerts(protection: 'idle' | 'busy' | 'results') {
  const [error, setError] = createSignal<ErrorContext | null>(null);
  const [errorVisible, setErrorVisible] = createSignal(false);
  const container = document.createElement('div');
  const previousAction = document.createElement('button');
  const reloadActivated = vi.fn();
  document.body.append(previousAction, container);
  previousAction.focus();
  dispose = render(
    () => (
      <>
        <AppUpdateNotice
          busy={protection === 'busy'}
          hasResults={protection === 'results'}
          webpReloadRequired={error()?.phase === 'wasm_webp_initialization'}
          onClearResults={() => {}}
          t={(key) => key}
        />
        <StatusAlerts
          t={(key) => key}
          environmentSupported
          errorContext={error()}
          errorMessage={errorVisible() ? (error()?.originalError ?? null) : null}
          onRetry={() => {}}
          onSelectNewFile={() => {}}
          onDismissError={() => {}}
        />
      </>
    ),
    container
  );

  function showError(type: ConversionErrorType, terminal = false) {
    // Match handlers that flush batched error UI before scheduling focus.
    batch(() => {
      setError({
        type,
        code: 'UNKNOWN',
        originalError: 'conversion failed',
        timestamp: 0,
        ...(terminal ? { phase: 'wasm_webp_initialization' } : {}),
      });
      setErrorVisible(true);
    });
    focusPrimaryErrorAction();
  }

  function reloadButton() {
    const reload = container.querySelector<HTMLButtonElement>(
      '[data-testid="app-recovery-reload"]'
    )!;
    reload.addEventListener('click', reloadActivated);
    return reload;
  }

  return { container, previousAction, showError, reloadButton, reloadActivated };
}

describe.each(['idle', 'busy', 'results'] as const)(
  'error focus with %s reload protection',
  (protection) => {
    it.each(['general', 'format', 'codec'] as const)(
      'keeps the %s error action focused with an earlier update notice',
      async (type) => {
        const { container, showError, reloadButton, reloadActivated } = mountAlerts(protection);
        deployment.onUpdate();
        const reload = reloadButton();
        expect(reload.disabled).toBe(protection !== 'idle');

        showError(type);
        // Settle ErrorDisplay.onMount and the handler's deferred focus together.
        await Promise.resolve();

        const action = container.querySelector(
          type === 'general'
            ? '[data-testid="error-retry-button"]'
            : '[data-testid="error-select-different-fallback-button"]'
        );
        expect(action).not.toBeNull();
        expect(document.activeElement).toBe(action);
        expect(reload.disabled).toBe(protection !== 'idle');
        expect(reloadActivated).not.toHaveBeenCalled();
      }
    );

    it('uses terminal initialization reload only when it is available', async () => {
      const { container, previousAction, showError, reloadButton, reloadActivated } =
        mountAlerts(protection);
      showError('general', true);
      const reload = reloadButton();
      await Promise.resolve();

      expect(container.querySelector('[data-testid="error-retry-button"]')).toBeNull();
      expect(
        container.querySelector('[data-testid="error-select-different-fallback-button"]')
      ).toBeNull();
      expect(container.querySelector('[data-testid="error-select-different-button"]')).toBeNull();
      expect(reload.disabled).toBe(protection !== 'idle');
      expect(document.activeElement).toBe(protection === 'idle' ? reload : previousAction);
      expect(reloadActivated).not.toHaveBeenCalled();
    });
  }
);
