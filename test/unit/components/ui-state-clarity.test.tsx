// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import ResultPreview from '@components/ResultPreview';
import SettingsPanel from '@components/SettingsPanel';
import VideoMetadataDisplay from '@components/VideoMetadataDisplay';
import type { ConversionSettings, VideoMetadata } from '@t/conversion-types';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({
    locale: () => 'en',
    t: (key: string) => key,
  }),
}));

const metadata: VideoMetadata = {
  width: 1920,
  height: 1080,
  duration: 12,
  codec: 'unknown',
  framerate: 30,
  bitrate: 0,
};

const settings: ConversionSettings = {
  format: 'gif',
  quality: 'medium',
  scale: 0.75,
  trimStart: 0,
  trimEnd: 0,
  smartFrameSkip: 'off',
};

describe('UI state clarity', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('presents finalized metadata as a collapsed disclosure with truthful unknown values', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <VideoMetadataDisplay
          fileName="sample.mp4"
          fileSize={18_400_000}
          metadata={metadata}
        />
      ),
      container
    );

    const disclosure = container.querySelector<HTMLDetailsElement>(
      '[data-testid="video-metadata"]'
    );
    expect(disclosure).toBeInstanceOf(HTMLDetailsElement);
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.querySelector('summary')?.textContent).toContain('metadata.title');
    expect(disclosure?.textContent).not.toContain('metadata.detecting');
    expect(disclosure?.textContent?.match(/metadata\.unavailable/g)).toHaveLength(2);
    expect(disclosure?.textContent).toContain('17.55 MB');
    expect(disclosure?.className).toContain('border-border-subtle');

    dispose();
  });

  it('puts smart frame skip in a native advanced disclosure without removing its controls', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <SettingsPanel
          isBusy={false}
          isCancelling={false}
          isConversionActive={false}
          metadata={metadata}
          onCancel={() => {}}
          onConvert={() => {}}
          onFormatChange={() => {}}
          onQualityChange={() => {}}
          onScaleChange={() => {}}
          onSmartFrameSkipChange={() => {}}
          settings={settings}
        />
      ),
      container
    );

    const disclosure = container.querySelector<HTMLDetailsElement>(
      '[data-testid="advanced-settings"]'
    );
    expect(disclosure).toBeInstanceOf(HTMLDetailsElement);
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.querySelector('summary')?.textContent).toContain(
      'settings.section.performance'
    );
    expect(disclosure?.querySelectorAll('input[name="smart-frame-skip"]')).toHaveLength(5);

    dispose();
  });

  it('keeps the focused download action visible after the preview replaces its skeleton', async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame');
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:result-preview');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const container = document.createElement('div');
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <ResultPreview
          originalName="sample.mp4"
          originalSize={1_000}
          outputBlob={new Blob(['result'], { type: 'image/gif' })}
          settings={settings}
        />
      ),
      container
    );
    await Promise.resolve();

    const image = container.querySelector<HTMLImageElement>('[data-testid="result-image"]');
    const download = container.querySelector<HTMLAnchorElement>(
      '[data-testid="download-result-button"]'
    );
    expect(image).toBeInstanceOf(HTMLImageElement);
    expect(download?.getAttribute('href')).toBe('blob:result-preview');
    expect(container.querySelector('.animate-pulse')).not.toBeNull();

    const scrollIntoView = vi.fn();
    Object.defineProperty(download, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    download?.focus();
    image?.dispatchEvent(new Event('load'));

    expect(container.querySelector('.animate-pulse')).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(animationFrames).toHaveLength(1);
    animationFrames[0]?.(performance.now());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });

    image?.dispatchEvent(new Event('load'));
    expect(animationFrames).toHaveLength(2);
    dispose();
    expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(2);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:result-preview');
  });

  it('does not scroll the result after the user moves focus elsewhere', async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:result-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const container = document.createElement('div');
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <ResultPreview
          originalName="sample.mp4"
          originalSize={1_000}
          outputBlob={new Blob(['result'], { type: 'image/webp' })}
          settings={{ ...settings, format: 'webp' }}
        />
      ),
      container
    );
    await Promise.resolve();

    const image = container.querySelector<HTMLImageElement>('[data-testid="result-image"]');
    const download = container.querySelector<HTMLAnchorElement>(
      '[data-testid="download-result-button"]'
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(download, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    download?.focus();
    image?.dispatchEvent(new Event('load'));

    const otherControl = document.createElement('button');
    document.body.appendChild(otherControl);
    otherControl.focus();
    animationFrames[0]?.(performance.now());
    expect(scrollIntoView).not.toHaveBeenCalled();

    dispose();
  });
});
