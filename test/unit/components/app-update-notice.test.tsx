import AppUpdateNotice from '@components/AppUpdateNotice';
import type { SWRegisterOptions } from '@/sw-types';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';

const registration = vi.hoisted(() => ({ options: {} as SWRegisterOptions, cleanup: vi.fn() }));
vi.mock('@/sw-register', () => ({ registerServiceWorker: vi.fn(async (options: SWRegisterOptions) => {
  registration.options = options;
  return { cleanup: registration.cleanup };
}) }));
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.clearAllMocks(); });

it('keeps reload explicit and disabled throughout an operation and while a downloadable result remains', async () => {
  const [busy, setBusy] = createSignal(true);
  const [hasResults, setResults] = createSignal(false);
  const container = document.createElement('div');
  document.body.append(container);
  dispose = render(() => <AppUpdateNotice busy={busy()} hasResults={hasResults()} t={(key) => key} />, container);
  await Promise.resolve();
  expect(container.querySelector('button')).toBeNull();
  registration.options.onAssetUnavailable?.();
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
});

it('cleans up a registration that resolves after its owner is disposed', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  dispose = render(() => <AppUpdateNotice busy={false} hasResults={false} t={(key) => key} />, container);
  dispose(); dispose = undefined;
  await Promise.resolve();
  expect(registration.cleanup).toHaveBeenCalledTimes(1);
});
