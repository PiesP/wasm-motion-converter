// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import ResultPreview from '@components/ResultPreview';
import SettingsPanel from '@components/SettingsPanel';
import VideoMetadataDisplay from '@components/VideoMetadataDisplay';
import type { ConversionSettings, VideoMetadata } from '@t/conversion-types';
import { createSignal } from 'solid-js';
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
    vi.unstubAllGlobals();
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
          isComplete={false}
          isConversionActive={false}
          metadata={metadata}
          onCancel={() => {}}
          onConvert={() => {}}
          onFormatChange={() => {}}
          onQualityChange={() => {}}
          onScaleChange={() => {}}
          onSharingSettings={() => {}}
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

  it('presents completed conversion as a secondary convert-again action', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <SettingsPanel
          isBusy={false}
          isCancelling={false}
          isComplete={true}
          isConversionActive={false}
          metadata={metadata}
          onCancel={() => {}}
          onConvert={() => {}}
          onFormatChange={() => {}}
          onQualityChange={() => {}}
          onScaleChange={() => {}}
          onSharingSettings={() => {}}
          onSmartFrameSkipChange={() => {}}
          settings={settings}
        />
      ),
      container
    );

    const convert = container.querySelector<HTMLButtonElement>('[data-testid="convert-button"]');
    expect(convert?.textContent).toContain('settings.convertAgain');
    expect(convert?.getAttribute('aria-label')).toBe('settings.convertAgain');
    expect(convert?.className).toContain('border-border-standard');
    expect(convert?.className).not.toContain('bg-brand ');

    dispose();
  });

  it('keeps the focused download action visible after the preview replaces its skeleton', async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame');
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:result-preview');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const container = document.createElement('div');
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <ResultPreview
          originalName="sample.mp4"
          originalSize={1_000}
          outputHeight={810}
          outputBlob={new Blob(['result'], { type: 'image/gif' })}
          outputWidth={1440}
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
    const summary = container.querySelector<HTMLElement>('[data-testid="result-summary"]');
    const resolution = container.querySelector<HTMLElement>('[data-result-resolution]');
    const actualSize = container.querySelector<HTMLButtonElement>(
      '[data-testid="preview-size-actual"]'
    );
    expect(summary?.className).toContain('text-xs');
    expect(summary?.className).toContain('text-text-secondary');
    expect(summary?.className).not.toContain('/70');
    expect(resolution?.textContent).toContain('1440×810');
    expect(actualSize?.getAttribute('aria-pressed')).toBe('true');
    expect(image?.className).toContain('w-auto');
    expect(download?.compareDocumentPosition(image!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

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
          outputHeight={45}
          outputBlob={new Blob(['result'], { type: 'image/webp' })}
          outputWidth={80}
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

  it('opts into reduced-motion previews, detaches the image when hidden, and preserves the download URL', async () => {
    const motionPreference = Object.assign(new EventTarget(), { matches: true });
    vi.stubGlobal('matchMedia', () => motionPreference);
    const createUrl = vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first-result')
      .mockReturnValueOnce('blob:second-result');
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    let replaceBlob: ((blob: Blob) => void) | undefined;
    let preferHidden: ((hidden: boolean) => void) | undefined;
    const dispose = render(() => {
      const [blob, setBlob] = createSignal(new Blob(['gif'], { type: 'image/gif' }));
      const [hidden, setHidden] = createSignal(false);
      replaceBlob = setBlob;
      preferHidden = setHidden;
      return <ResultPreview originalName="sample.mp4" originalSize={1000} outputBlob={blob()} outputWidth={80} outputHeight={45} settings={settings} preferHidden={hidden()} onPreviewHidden={() => setHidden(true)} />;
    }, container);
    await Promise.resolve();

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="result-preview-toggle"]')!;
    const download = container.querySelector<HTMLAnchorElement>('[data-testid="download-result-button"]')!;
    expect(toggle.textContent).toContain('result.showPreview');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="result-image"]')).toBeNull();
    expect(container.querySelector('[data-testid="result-summary"]')).not.toBeNull();
    expect(download.href).toContain('blob:first-result');

    toggle.focus();
    toggle.click();
    expect(toggle.textContent).toContain('result.hidePreview');
    const firstImage = container.querySelector('[data-testid="result-image"]');
    expect(firstImage).not.toBeNull();
    expect(document.activeElement).toBe(toggle);
    toggle.click();
    expect(container.querySelector('[data-testid="result-image"]')).toBeNull();
    expect(container.querySelector('[data-testid="result-preview-hidden"]')).not.toBeNull();
    expect(download.href).toContain('blob:first-result');
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(revokeUrl).not.toHaveBeenCalled();

    firstImage?.dispatchEvent(new Event('load'));
    toggle.click();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    motionPreference.matches = false;
    motionPreference.dispatchEvent(new Event('change'));
    expect(container.querySelector('[data-testid="result-image"]')).not.toBeNull();
    expect(preferHidden).toBeTypeOf('function');
    replaceBlob?.(new Blob(['webp'], { type: 'image/webp' }));
    await Promise.resolve();
    expect(toggle.textContent).toContain('result.showPreview');
    expect(container.querySelector('[data-testid="result-image"]')).toBeNull();
    expect(download.getAttribute('href')).toBe('blob:second-result');
    expect(download.getAttribute('download')).toBe('sample.webp');
    expect(revokeUrl).toHaveBeenCalledWith('blob:first-result');

    dispose();
    expect(revokeUrl).toHaveBeenCalledWith('blob:second-result');
  });

  it('follows motion preference changes until the user makes an explicit preview choice', async () => {
    const motionPreference = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal('matchMedia', () => motionPreference);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:motion-result');
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    const dispose = render(
      () => <ResultPreview originalName="sample.mp4" originalSize={1000} outputBlob={new Blob(['gif'], { type: 'image/gif' })} outputWidth={80} outputHeight={45} settings={settings} />,
      container
    );
    await Promise.resolve();
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="result-preview-toggle"]')!;
    expect(container.querySelector('[data-testid="result-image"]')).not.toBeNull();
    motionPreference.matches = true;
    motionPreference.dispatchEvent(new Event('change'));
    expect(container.querySelector('[data-testid="result-image"]')).toBeNull();
    motionPreference.matches = false;
    motionPreference.dispatchEvent(new Event('change'));
    expect(container.querySelector('[data-testid="result-image"]')).not.toBeNull();
    toggle.click();
    motionPreference.matches = true;
    motionPreference.dispatchEvent(new Event('change'));
    motionPreference.matches = false;
    motionPreference.dispatchEvent(new Event('change'));
    expect(container.querySelector('[data-testid="result-image"]')).toBeNull();
    expect(revokeUrl).not.toHaveBeenCalled();
    dispose();
    expect(revokeUrl).toHaveBeenCalledOnce();
  });
});
