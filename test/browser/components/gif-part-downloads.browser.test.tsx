// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import GifPartDownloads from '@components/GifPartDownloads';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { expect, it, vi } from 'vite-plus/test';

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({
    t: (key: string, params?: { filename: string }) =>
      params ? `${key}: ${params.filename}` : key,
  }),
}));

it('keeps only a discard retry after removing the OPFS result fails', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const storage = {
    filename: 'continuous.gif',
    read: vi.fn(),
    dispose: vi.fn().mockRejectedValueOnce(new Error('blocked')).mockResolvedValueOnce(undefined),
  };
  const discarded = vi.fn();
  const dispose = render(
    () => <GifPartDownloads storage={storage} busy={false} onDiscard={discarded} />,
    container
  );
  try {
    const clear = container.querySelector<HTMLButtonElement>('[data-testid="discard-gif-parts"]')!;
    clear.click();
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="prepare-gif-part-download"]')).toBeNull();
    expect(discarded).not.toHaveBeenCalled();
    expect(clear.disabled).toBe(false);
    clear.click();
    await vi.waitFor(() => expect(discarded).toHaveBeenCalledOnce());
    expect(storage.read).not.toHaveBeenCalled();
  } finally {
    dispose();
    container.remove();
  }
});

it('finishes the selected native save through unrelated conversion activity', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const [busy, setBusy] = createSignal(false);
  const writeCompletion = Promise.withResolvers<void>();
  const closeCompletion = Promise.withResolvers<void>();
  const write = vi.fn(() => writeCompletion.promise);
  const close = vi.fn(() => closeCompletion.promise);
  const abort = vi.fn();
  const createWritable = vi.fn(async () => new WritableStream({ write, close, abort }));
  const picker = vi.fn(async () => ({ name: 'renamed.gif', createWritable }));
  vi.stubGlobal('showSaveFilePicker', picker);
  const file = new File([new Uint8Array([1, 2, 3])], 'continuous.gif');
  const storage = {
    filename: file.name,
    read: vi.fn(async () => file),
    dispose: vi.fn(async () => undefined),
  };
  const renderDispose = render(
    () => <GifPartDownloads storage={storage} busy={busy()} onDiscard={vi.fn()} />,
    container
  );
  try {
    const save = container.querySelector<HTMLButtonElement>(
      '[data-testid="prepare-gif-part-download"]'
    )!;
    const clear = container.querySelector<HTMLButtonElement>('[data-testid="discard-gif-parts"]')!;
    save.click();
    expect(picker).toHaveBeenCalledExactlyOnceWith({ suggestedName: 'continuous.gif' });
    await vi.waitFor(() =>
      expect(write).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1, 2, 3]), expect.anything())
    );
    setBusy(true);
    expect(clear.disabled).toBe(true);
    setBusy(false);
    expect(clear.disabled).toBe(true);
    expect(close).not.toHaveBeenCalled();
    writeCompletion.resolve();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(abort).not.toHaveBeenCalled();
    expect(clear.disabled).toBe(true);
    clear.click();
    expect(storage.dispose).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="download-gif-part"]')).toBeNull();
    closeCompletion.resolve();
    await vi.waitFor(() => expect(clear.disabled).toBe(false));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'result.continuousGifSaved: renamed.gif'
    );
  } finally {
    writeCompletion.resolve();
    closeCompletion.resolve();
    renderDispose();
    vi.unstubAllGlobals();
    container.remove();
  }
});
