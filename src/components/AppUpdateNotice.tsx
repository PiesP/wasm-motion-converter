import type { TFunction } from '@t/i18n-types';
import { type Component, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { registerServiceWorker } from '@/sw-register';

const AppUpdateNotice: Component<{ busy: boolean; hasResults: boolean; t: TFunction }> = (
  props
) => {
  const [notice, setNotice] = createSignal<'available' | 'unavailable' | null>(null);
  let disposed = false;
  let cleanup: (() => void) | undefined;
  onMount(() => {
    void registerServiceWorker({
      onUpdate: () => setNotice('available'),
      onAssetUnavailable: () => setNotice('unavailable'),
    }).then((registration) => {
      if (disposed) registration.cleanup?.();
      else cleanup = registration.cleanup;
    });
  });
  onCleanup(() => {
    disposed = true;
    cleanup?.();
  });
  const reload = (): void => {
    if (!props.busy && !props.hasResults) window.location.reload();
  };
  return (
    <Show when={notice()}>
      <div
        role="status"
        class="mb-6 space-y-2 rounded-lg border border-border-standard bg-bg-elevated p-4 text-text-primary"
      >
        <p>{props.t(notice() === 'available' ? 'update.available' : 'update.unavailable')}</p>
        <Show when={props.busy}>
          <p>{props.t('update.wait')}</p>
        </Show>
        <Show when={props.hasResults}>
          <p>{props.t('update.download')}</p>
        </Show>
        <button
          type="button"
          disabled={props.busy || props.hasResults}
          onClick={reload}
          class="rounded-md bg-brand px-4 py-2 font-medium text-brand-foreground disabled:opacity-50"
        >
          {props.t('app.error.reload')}
        </button>
      </div>
    </Show>
  );
};

export default AppUpdateNotice;
