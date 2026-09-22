// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import SettingsPanel from '@components/SettingsPanel';
import { DEFAULT_CONVERSION_SETTINGS } from '@stores/conversion-settings-store';
import type { TFunction } from '@t/i18n-types';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';

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
  dispose = render(() => (
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
      onSmartFrameSkipChange={() => {}}
      onSharingSettings={onSharingSettings}
    />
  ), container);

  const button = container.querySelector<HTMLButtonElement>('[data-testid="sharing-settings-button"]');
  expect(button?.disabled).toBe(true);
  button?.click();
  expect(onSharingSettings).not.toHaveBeenCalled();

  setBusy(false);
  expect(button?.disabled).toBe(false);
  button?.click();
  expect(onSharingSettings).toHaveBeenCalledOnce();
});
