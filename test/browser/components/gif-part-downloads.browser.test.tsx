// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import GifPartDownloads from '@components/GifPartDownloads';
import { render } from 'solid-js/web';
import { expect, it, vi } from 'vite-plus/test';

vi.mock('@hooks/use-locale', () => ({ useLocale: () => ({ t: (key: string) => key }) }));

it('keeps only a discard retry after database deletion fails', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const storage = {
    count: 1,
    files: () => [{ filename: 'part.gif', bytes: 10 }],
    read: vi.fn(),
    save: vi.fn(),
    finish: vi.fn(),
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

it('keeps the OPFS result until the selected destination closes', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const completion = Promise.withResolvers<void>();
  const close = vi.fn(() => completion.promise);
  const write = vi.fn();
  const createWritable = vi.fn(async () => new WritableStream({ write, close }));
  const picker = vi.fn(async () => ({ createWritable }));
  vi.stubGlobal('showSaveFilePicker', picker);
  const blob = new Blob([new Uint8Array([1, 2, 3])]);
  const storage = {
    count: 1,
    files: () => [{ filename: 'continuous.gif', bytes: blob.size }],
    read: vi.fn(async () => blob),
    save: vi.fn(),
    finish: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
  const renderDispose = render(
    () => <GifPartDownloads storage={storage} busy={false} continuousGif onDiscard={vi.fn()} />,
    container
  );
  try {
    const save = container.querySelector<HTMLButtonElement>(
      '[data-testid="prepare-gif-part-download"]'
    )!;
    const clear = container.querySelector<HTMLButtonElement>('[data-testid="discard-gif-parts"]')!;
    save.click();
    expect(picker).toHaveBeenCalledExactlyOnceWith({ suggestedName: 'continuous.gif' });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(write).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1, 2, 3]), expect.anything());
    expect(clear.disabled).toBe(true);
    clear.click();
    expect(storage.dispose).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="download-gif-part"]')).toBeNull();
    completion.resolve();
    await vi.waitFor(() => expect(clear.disabled).toBe(false));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'result.continuousGifSaved'
    );
  } finally {
    completion.resolve();
    renderDispose();
    vi.unstubAllGlobals();
    container.remove();
  }
});
