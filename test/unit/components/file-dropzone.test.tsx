// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import FileDropzone from '@components/FileDropzone';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({
    locale: () => 'en',
    t: (key: string) => key,
  }),
}));

function selectFile(input: HTMLInputElement, name: string): void {
  const file = new File(['video'], name, { type: 'video/mp4' });
  const files = {
    0: file,
    item: (index: number) => (index === 0 ? file : null),
    length: 1,
  } as unknown as FileList;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('FileDropzone selection feedback timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('replaces the pending timeout when another file is selected', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onFileSelected = vi.fn();
    const dispose = render(() => <FileDropzone onFileSelected={onFileSelected} />, container);
    const input = container.querySelector<HTMLInputElement>('[data-testid="file-input"]')!;

    selectFile(input, 'first.mp4');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(250);
    selectFile(input, 'second.mp4');

    expect(onFileSelected).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    dispose();
  });

  it('clears pending selection feedback when unmounted', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const dispose = render(() => <FileDropzone onFileSelected={() => {}} />, container);
    const input = container.querySelector<HTMLInputElement>('[data-testid="file-input"]')!;

    selectFile(input, 'video.mp4');
    expect(vi.getTimerCount()).toBe(1);

    dispose();

    expect(vi.getTimerCount()).toBe(0);
  });
});
