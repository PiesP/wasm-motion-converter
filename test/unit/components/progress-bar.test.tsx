// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import * as ProgressBarModule from '@components/ProgressBar';
import type { ProgressPhase } from '@t/conversion-types';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({
    locale: () => 'en',
    t: (key: string) => key,
  }),
}));

const ProgressBar = ProgressBarModule.default;

describe('ProgressBar pipeline phase segments', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each([
    { progress: 0, phase: 'demuxing', widths: [0, 0, 0, 0] },
    { progress: 3, phase: 'decoding', widths: [3, 0, 0, 0] },
    { progress: 73, phase: 'encoding', widths: [3, 70, 0, 0] },
    { progress: 93, phase: 'assembling', widths: [3, 70, 20, 0] },
    { progress: 100, phase: 'assembling', widths: [3, 70, 20, 7] },
  ] as const)(
    'renders pipeline-weighted segment widths at $progress% global progress',
    ({ progress, phase, widths }) => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      render(
        () => <ProgressBar progress={progress} status="Converting" phase={phase} />,
        container
      );

      const progressbar = container.querySelector<HTMLElement>('[role="progressbar"]');
      expect(progressbar).not.toBeNull();
      expect(Array.from(progressbar!.children, (segment) => (segment as HTMLElement).style.width)).toEqual(
        widths.map((width) => `${width}%`)
      );
    }
  );

  it('exposes the active phase order used by phase labels and segments', () => {
    const getActivePhaseIndex = (
      ProgressBarModule as unknown as {
        getActivePhaseIndex?: (phase?: ProgressPhase) => number;
      }
    ).getActivePhaseIndex;

    expect(getActivePhaseIndex).toBeTypeOf('function');
    expect(getActivePhaseIndex?.('demuxing')).toBe(0);
    expect(getActivePhaseIndex?.('decoding')).toBe(1);
    expect(getActivePhaseIndex?.('encoding')).toBe(2);
    expect(getActivePhaseIndex?.('assembling')).toBe(3);
  });

  it('exposes a pure segment-width calculation for pipeline boundaries', () => {
    const getProgressSegmentWidths = (
      ProgressBarModule as unknown as {
        getProgressSegmentWidths?: (progress: number) => readonly number[];
      }
    ).getProgressSegmentWidths;

    expect(getProgressSegmentWidths).toBeTypeOf('function');
    expect(getProgressSegmentWidths?.(73)).toEqual([3, 70, 0, 0]);
  });

  it('keeps the active weighted segment pulsing before its phase boundary', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(
      () => <ProgressBar progress={50} status="Converting" phase="decoding" />,
      container
    );

    const segments = container.querySelector<HTMLElement>('[role="progressbar"]')!.children;
    expect(segments[1]?.classList.contains('animate-pulse')).toBe(true);
  });

  it('stops pulsing when the active weighted segment reaches its boundary', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(
      () => <ProgressBar progress={100} status="Converting" phase="assembling" />,
      container
    );

    const segments = container.querySelector<HTMLElement>('[role="progressbar"]')!.children;
    expect(segments[3]?.classList.contains('animate-pulse')).toBe(false);
  });

  it('preserves the progress diagnostic attribute in compact mode', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(
      () => <ProgressBar compact progress={42.4} status="Converting" phase="decoding" />,
      container
    );

    const progressbar = container.querySelector<HTMLElement>('[role="progressbar"]');
    expect(progressbar?.dataset.progress).toBe('42');
  });
});
