// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import FileDropzone from '@components/FileDropzone';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

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

describe('FileDropzone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('opens the persistent picker for Change and keeps selection on empty picker input', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const onFileSelected = vi.fn();
    const dispose = render(
      () => (
        <FileDropzone
          onFileSelected={onFileSelected}
          previewUrl="blob:selected"
          fileName="selected.mp4"
          duration={10}
          onTrimChange={() => {}}
        />
      ),
      container
    );
    const input = container.querySelector<HTMLInputElement>('[data-testid="file-input"]')!;
    const change = container.querySelector<HTMLButtonElement>(
      '[data-testid="change-file-button"]'
    )!;
    const openPicker = vi.spyOn(input, 'click').mockImplementation(() => {});
    expect(input).not.toBeNull();
    change.click();
    expect(openPicker).toHaveBeenCalledOnce();
    expect(container.querySelector('#selection-preview-video')).not.toBeNull();

    Object.defineProperty(input, 'files', { configurable: true, value: { length: 0 } });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onFileSelected).not.toHaveBeenCalled();
    expect(container.querySelector('#selection-preview-video')).not.toBeNull();

    selectFile(input, 'selected.mp4');
    selectFile(input, 'selected.mp4');
    expect(onFileSelected).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('shows preview failure without discarding trim and ignores an old play rejection', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const [url, setUrl] = createSignal('blob:first');
    const dispose = render(
      () => (
        <FileDropzone
          onFileSelected={() => {}}
          previewUrl={url()}
          duration={10}
          trimStart={2}
          trimEnd={3}
          onTrimChange={() => {}}
        />
      ),
      container
    );
    const video = container.querySelector<HTMLVideoElement>('#selection-preview-video')!;
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      value: HTMLMediaElement.HAVE_METADATA,
    });
    let rejectPlay: (error: Error) => void = () => {};
    vi.spyOn(video, 'play').mockImplementation(
      () => new Promise<void>((_resolve, reject) => (rejectPlay = reject))
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="trim-preview-button"]'
    )!;
    button.click();
    rejectPlay(new Error('preview rejected'));
    await Promise.resolve();
    expect(container.querySelector('[data-testid="selection-preview-unavailable"]')).not.toBeNull();
    expect(button.textContent).toContain('dropzone.retryPreview');
    expect(container.querySelector('#trim-start-input')).not.toBeNull();

    video.dispatchEvent(new Event('loadedmetadata'));
    expect(container.querySelector('[data-testid="selection-preview-unavailable"]')).toBeNull();
    button.click();
    setUrl('blob:second');
    rejectPlay(new Error('old preview rejected'));
    await Promise.resolve();
    expect(container.querySelector('[data-testid="selection-preview-unavailable"]')).toBeNull();

    video.dispatchEvent(new Event('error'));
    expect(container.querySelector('[data-testid="selection-preview-unavailable"]')).not.toBeNull();
    dispose();
  });

  it('keeps selected-range playback control with the video and preserves focus', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const dispose = render(
      () => (
        <FileDropzone
          onFileSelected={() => {}}
          previewUrl="blob:selection-preview"
          duration={10}
          trimStart={2}
          trimEnd={4}
          onTrimChange={() => {}}
        />
      ),
      container
    );
    const player = container.querySelector<HTMLElement>('[data-testid="selection-preview-player"]');
    const video = player?.querySelector<HTMLVideoElement>('video');
    const button = player?.querySelector<HTMLButtonElement>('[data-testid="trim-preview-button"]');

    expect(player).not.toBeNull();
    expect(video).not.toBeNull();
    expect(button).not.toBeNull();
    expect(
      container.querySelector('[data-testid="trim-selector"] [data-testid="trim-preview-button"]')
    ).toBeNull();

    Object.defineProperties(video!, {
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_METADATA },
      duration: { configurable: true, value: 10 },
      currentTime: { configurable: true, writable: true, value: 0 },
    });
    const play = vi.fn().mockResolvedValue(undefined);
    const pause = vi.fn(() => video!.dispatchEvent(new Event('pause')));
    Object.defineProperties(video!, {
      play: { configurable: true, value: play },
      pause: { configurable: true, value: pause },
    });

    button!.focus();
    button!.click();
    await Promise.resolve();

    expect(video!.currentTime).toBe(2);
    expect(play).toHaveBeenCalledOnce();
    expect(button!.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(button);

    video!.currentTime = 4;
    video!.dispatchEvent(new Event('timeupdate'));

    expect(pause).toHaveBeenCalledOnce();
    expect(video!.currentTime).toBe(2);
    expect(button!.getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(button);
    expect(player?.querySelector<HTMLButtonElement>('[data-testid="trim-preview-button"]')).toBe(
      button
    );

    dispose();
  });

  it('requests the first decodable frame when a selected preview is remounted', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const dispose = render(
      () => (
        <FileDropzone
          onFileSelected={() => {}}
          previewUrl="blob:selection-preview"
          duration={10}
          trimStart={0}
          trimEnd={0}
          onTrimChange={() => {}}
        />
      ),
      container
    );
    const video = container.querySelector<HTMLVideoElement>('#selection-preview-video')!;
    Object.defineProperties(video, {
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_METADATA },
      duration: { configurable: true, value: 10 },
      currentTime: { configurable: true, writable: true, value: 0 },
    });

    video.dispatchEvent(new Event('loadedmetadata'));

    expect(video.currentTime).toBe(0.001);
    dispose();
  });
});
