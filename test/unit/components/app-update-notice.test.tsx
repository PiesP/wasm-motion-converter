import AppUpdateNotice from '@components/AppUpdateNotice';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { clearAssetFailure } from '@/asset-recovery';
import type { SWRegisterOptions } from '@/sw-types';

const unavailable = {
  path: '/assets/codec.ABCDef12.js',
  status: 404,
  reason: 'invalid-response',
  source: 'service-worker',
} as const;

const registration = vi.hoisted(() => ({
  options: {} as SWRegisterOptions,
  cleanup: vi.fn(),
  deploymentUpdate: () => {},
  deploymentCleanup: vi.fn(),
}));
vi.mock('@/deployment-update', () => ({
  observeDeploymentUpdates: vi.fn((options: { onUpdate: () => void }) => {
    registration.deploymentUpdate = options.onUpdate;
    return registration.deploymentCleanup;
  }),
}));
vi.mock('@/sw-register', () => ({
  registerServiceWorker: vi.fn(async (options: SWRegisterOptions) => {
    registration.options = options;
    return { cleanup: registration.cleanup };
  }),
}));
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  clearAssetFailure();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it('keeps reload explicit and disabled throughout an operation and while a downloadable result remains', async () => {
  const [busy, setBusy] = createSignal(true);
  const [hasResults, setResults] = createSignal(false);
  const container = document.createElement('div');
  document.body.append(container);
  dispose = render(
    () => (
      <AppUpdateNotice
        busy={busy()}
        hasResults={hasResults()}
        onClearResults={() => {}}
        t={(key) => key}
      />
    ),
    container
  );
  await Promise.resolve();
  expect(container.querySelector('button')).toBeNull();
  registration.options.onAssetUnavailable?.(unavailable);
  const button = container.querySelector('button')!;
  expect(button.disabled).toBe(true);
  expect(container.textContent).toContain('update.wait');
  setResults(true);
  setBusy(false);
  expect(button.disabled).toBe(true);
  expect(container.textContent).toContain('update.download');
  setResults(false);
  expect(button.disabled).toBe(false);
  expect(container.textContent).toContain('update.unavailable');
  dispose?.();
  dispose = undefined;
  expect(registration.cleanup).toHaveBeenCalledTimes(1);
  expect(registration.deploymentCleanup).toHaveBeenCalledTimes(1);
});

it('clears a retained result only through an explicit idle action and then allows reload', async () => {
  const [busy, setBusy] = createSignal(true);
  const [hasResults, setResults] = createSignal(true);
  const clearResults = vi.fn(() => setResults(false));
  const container = document.createElement('div');
  document.body.append(container);
  dispose = render(
    () => (
      <AppUpdateNotice
        busy={busy()}
        hasResults={hasResults()}
        onClearResults={clearResults}
        t={(key) => key}
      />
    ),
    container
  );
  await Promise.resolve();
  registration.deploymentUpdate();
  const buttons = Array.from(container.querySelectorAll('button'));
  const clear = buttons.find((button) => button.textContent === 'update.clearResults')!;
  const reload = buttons.find((button) => button.textContent === 'app.error.reload')!;
  expect(clear.disabled).toBe(true);
  clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(clearResults).not.toHaveBeenCalled();
  expect(hasResults()).toBe(true);
  setBusy(false);
  expect(clear.disabled).toBe(false);
  expect(reload.disabled).toBe(true);
  expect(clearResults).not.toHaveBeenCalled();
  clear.click();
  expect(clearResults).toHaveBeenCalledTimes(1);
  expect(hasResults()).toBe(false);
  expect(clear.isConnected).toBe(false);
  expect(reload.disabled).toBe(false);
  clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(clearResults).toHaveBeenCalledTimes(1);
});

it('coalesces worker and deployment updates while preserving a distinct unavailable warning', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  dispose = render(
    () => (
      <AppUpdateNotice busy={false} hasResults={false} onClearResults={() => {}} t={(key) => key} />
    ),
    container
  );
  await Promise.resolve();
  registration.deploymentUpdate();
  registration.options.onUpdate?.();
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(container.textContent).toContain('update.available');
  registration.options.onAssetUnavailable?.(unavailable);
  registration.deploymentUpdate();
  registration.options.onUpdate?.();
  expect(container.textContent).toContain('update.unavailable');
  expect(container.textContent).not.toContain('update.available');
  dispose();
  dispose = undefined;
  registration.deploymentUpdate();
  registration.options.onAssetUnavailable?.(unavailable);
  expect(container.childNodes).toHaveLength(0);
});

it('cleans up a registration that resolves after its owner is disposed', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  dispose = render(
    () => (
      <AppUpdateNotice busy={false} hasResults={false} onClearResults={() => {}} t={(key) => key} />
    ),
    container
  );
  dispose();
  dispose = undefined;
  await Promise.resolve();
  expect(registration.cleanup).toHaveBeenCalledTimes(1);
});
