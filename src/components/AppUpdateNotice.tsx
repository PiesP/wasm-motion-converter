import type { TFunction } from '@t/i18n-types';
import { type Component, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { assetFailure, reportAssetFailure } from '@/asset-recovery';
import { observeDeploymentUpdates } from '@/deployment-update';
import { canReload, reloadWhenSafe } from '@/reload-protection';

/** Vite replaces this with the clean source SHA; unknown local builds receive null. */
declare const __APP_SOURCE_SHA__: string | null;

import { registerServiceWorker } from '@/sw-register';

const AppUpdateNotice: Component<{
  busy: boolean;
  hasResults: boolean;
  onClearResults: () => void;
  t: TFunction;
}> = (props) => {
  const [notice, setNotice] = createSignal<'available' | null>(null);
  let disposed = false;
  let cleanup: (() => void) | undefined;
  let cleanupDeployment: (() => void) | undefined;
  const available = (): void => {
    if (!disposed) setNotice('available');
  };
  const currentNotice = createMemo(() => (assetFailure() ? 'unavailable' : notice()));
  onMount(() => {
    cleanupDeployment = observeDeploymentUpdates({
      sourceSha: __APP_SOURCE_SHA__,
      onUpdate: available,
    });
    void registerServiceWorker({
      onUpdate: available,
      onAssetUnavailable: (evidence) => {
        if (!disposed) reportAssetFailure(evidence);
      },
    }).then((registration) => {
      if (disposed) registration.cleanup?.();
      else cleanup = registration.cleanup;
    });
  });
  onCleanup(() => {
    disposed = true;
    cleanupDeployment?.();
    cleanup?.();
  });
  const reload = (): void => {
    reloadWhenSafe(
      () => props.busy,
      () => props.hasResults
    );
  };
  const clearResults = (): void => {
    if (!disposed && !props.busy && props.hasResults) props.onClearResults();
  };
  return (
    <Show when={currentNotice()}>
      <div
        role="status"
        class="mb-6 space-y-2 rounded-lg border border-border-standard bg-bg-elevated p-4 text-text-primary"
      >
        <p>
          {props.t(currentNotice() === 'available' ? 'update.available' : 'update.unavailable')}
        </p>
        <Show when={props.busy}>
          <p>{props.t('update.wait')}</p>
        </Show>
        <Show when={props.hasResults}>
          <p>{props.t('update.download')}</p>
        </Show>
        <button
          type="button"
          disabled={!canReload(props.busy, props.hasResults)}
          onClick={reload}
          class="rounded-md bg-brand px-4 py-2 font-medium text-brand-foreground disabled:opacity-50"
        >
          {props.t('app.error.reload')}
        </button>
        <Show when={props.hasResults}>
          <button
            type="button"
            disabled={props.busy}
            onClick={clearResults}
            class="ms-3 rounded-md border border-border-standard px-4 py-2 font-medium disabled:opacity-50"
          >
            {props.t('update.clearResults')}
          </button>
        </Show>
      </div>
    </Show>
  );
};

export default AppUpdateNotice;
