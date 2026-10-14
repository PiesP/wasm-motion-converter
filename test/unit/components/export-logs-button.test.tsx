import { logger } from '@utils/logger';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));

vi.mock('@utils/logger', () => ({
  logger: {
    getRecentLogs: vi.fn(() => []),
    getRecentEntries: vi.fn(() => []),
    warn: vi.fn(),
  },
}));

import ExportLogsButton from '@components/ExportLogsButton';

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
let disposeView: (() => void) | undefined;

afterEach(() => {
  disposeView?.();
  disposeView = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalCreateObjectURL)
    Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevokeObjectURL)
    Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
  document.body.replaceChildren();
});

it('keeps the log Blob URL alive through the browser download handoff, then releases it', async () => {
  vi.useFakeTimers();
  vi.mocked(logger.warn).mockClear();
  const revoked = new Set<string>();
  const revoke = vi.fn((url: string) => revoked.add(url));
  const create = vi.fn(() => 'blob:logs-one');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });

  const handedOff: boolean[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    const url = this.href;
    setTimeout(() => handedOff.push(!revoked.has(url)), 0);
  });
  const container = document.createElement('div');
  document.body.append(container);
  disposeView = render(() => <ExportLogsButton />, container);
  container.querySelector<HTMLButtonElement>('[data-testid="export-logs-button"]')!.click();

  expect(create).toHaveBeenCalledTimes(1);
  expect(revoke).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(handedOff).toEqual([true]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(revoke).toHaveBeenCalledWith('blob:logs-one');
  expect(logger.warn).not.toHaveBeenCalledWith('general', 'export-failed');
  disposeView?.();
  disposeView = undefined;
});

it('releases a pending log URL when the owning button unmounts', () => {
  vi.useFakeTimers();
  const revoke = vi.fn();
  let nextUrl = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:logs-pending-${++nextUrl}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const container = document.createElement('div');
  document.body.append(container);
  disposeView = render(() => <ExportLogsButton />, container);
  container.querySelector<HTMLButtonElement>('[data-testid="export-logs-button"]')!.click();
  container.querySelector<HTMLButtonElement>('[data-testid="export-logs-button"]')!.click();
  expect(revoke).not.toHaveBeenCalled();
  disposeView?.();
  disposeView = undefined;
  expect(revoke).toHaveBeenCalledTimes(2);
  expect(revoke).toHaveBeenCalledWith('blob:logs-pending-1');
  expect(revoke).toHaveBeenCalledWith('blob:logs-pending-2');
  vi.advanceTimersByTime(10_000);
  expect(revoke).toHaveBeenCalledTimes(2);
});

it('bounds rapid log exports and re-enables the button after the handoff window', async () => {
  vi.useFakeTimers();
  let nextUrl = 0;
  const create = vi.fn(() => `blob:logs-${++nextUrl}`);
  const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const container = document.createElement('div');
  document.body.append(container);
  disposeView = render(() => <ExportLogsButton />, container);
  const button = container.querySelector<HTMLButtonElement>('[data-testid="export-logs-button"]')!;

  button.click();
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
  expect(create).toHaveBeenCalledTimes(2);
  expect(button.disabled).toBe(true);
  button.click();
  expect(create).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(9_999);
  expect(button.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(revoke).toHaveBeenCalledTimes(2);
  expect(button.disabled).toBe(false);
  button.click();
  expect(create).toHaveBeenCalledTimes(3);

  disposeView?.();
  disposeView = undefined;
  expect(revoke).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(revoke).toHaveBeenCalledTimes(3);
});
