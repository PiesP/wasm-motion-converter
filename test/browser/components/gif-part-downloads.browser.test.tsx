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
