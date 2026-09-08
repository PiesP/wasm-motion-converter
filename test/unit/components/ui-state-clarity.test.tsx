// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

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
});
