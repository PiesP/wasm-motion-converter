// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import SettingsPanel from '@components/SettingsPanel';
import { DEFAULT_CONVERSION_SETTINGS } from '@stores/conversion-settings-store';
import type { TFunction } from '@t/i18n-types';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vite-plus/test';

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({ locale: () => 'en', t: ((key: string) => key) as TFunction }),
}));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = '';
});

it('keeps sharing settings unavailable while the application is busy', () => {
  const [busy, setBusy] = createSignal(true);
  const onSharingSettings = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  dispose = render(
    () => (
      <SettingsPanel
        isBusy={busy()}
        isCancelling={false}
        isComplete={false}
        isConversionActive={busy()}
        settings={DEFAULT_CONVERSION_SETTINGS}
        metadata={null}
        onConvert={() => {}}
        onCancel={() => {}}
        onFormatChange={() => {}}
        onQualityChange={() => {}}
        onScaleChange={() => {}}
        onPlayCountChange={() => {}}
        onSmartFrameSkipChange={() => {}}
        onSharingSettings={onSharingSettings}
      />
    ),
    container
  );

  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="sharing-settings-button"]'
  );
  expect(button?.disabled).toBe(true);
  button?.click();
  expect(onSharingSettings).not.toHaveBeenCalled();

  setBusy(false);
  expect(button?.disabled).toBe(false);
  button?.click();
  expect(onSharingSettings).toHaveBeenCalledOnce();
});

it('shows every supported conversion choice in the established order', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  dispose = render(
    () => (
      <SettingsPanel
        isBusy={false}
        isCancelling={false}
        isComplete={false}
        isConversionActive={false}
        settings={DEFAULT_CONVERSION_SETTINGS}
        metadata={null}
        onConvert={() => {}}
        onCancel={() => {}}
        onFormatChange={() => {}}
        onQualityChange={() => {}}
        onScaleChange={() => {}}
        onPlayCountChange={() => {}}
        onSmartFrameSkipChange={() => {}}
        onSharingSettings={() => {}}
      />
    ),
    container
  );

  for (const [name, expected] of [
    ['format', ['gif', 'webp']],
    ['quality', ['low', 'medium', 'high']],
    ['scale', ['0.5', '0.75', '1']],
    ['playback-count', ['forever', 'once', 'custom']],
    ['smart-frame-skip', ['off', 'low', 'medium', 'high', 'adaptive']],
  ] as const) {
    const actual = [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map(
      (input) => input.value
    );
    expect(actual).toEqual(expected);
  }
});

it('commits only valid custom playback counts and keeps the mode when editing', () => {
  const [settings, setSettings] = createSignal(DEFAULT_CONVERSION_SETTINGS);
  const container = document.createElement('div');
  document.body.appendChild(container);
  dispose = render(
    () => (
      <SettingsPanel
        isBusy={false}
        isCancelling={false}
        isComplete={false}
        isConversionActive={false}
        settings={settings()}
        metadata={null}
        onConvert={() => {}}
        onCancel={() => {}}
        onFormatChange={() => {}}
        onQualityChange={() => {}}
        onScaleChange={() => {}}
        onPlayCountChange={(playCount) => setSettings({ ...settings(), playCount })}
        onSmartFrameSkipChange={() => {}}
        onSharingSettings={() => {}}
      />
    ),
    container
  );
  const choose = (mode: string) =>
    container.querySelector<HTMLInputElement>(`input[name="playback-count"][value="${mode}"]`)!.click();
  choose('custom');
  const input = container.querySelector<HTMLInputElement>('[data-testid="custom-playback-count"]')!;
  expect(settings().playCount).toBe(3);
  const edit = (value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  edit('');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(settings().playCount).toBe(3);
  edit('65535');
  expect(input.getAttribute('aria-invalid')).toBe('false');
  expect(settings().playCount).toBe(65535);
  choose('once');
  expect(settings().playCount).toBe(1);
  expect(container.querySelector('[data-testid="custom-playback-count"]')).toBeNull();
  choose('forever');
  expect(settings().playCount).toBe(0);
});
