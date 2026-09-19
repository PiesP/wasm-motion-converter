// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import * as ProgressBarModule from '@components/ProgressBar';
import type { ProgressPhase } from '@t/conversion-types';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  mountCompactProgressHarness,
  mountResultPreviewHarness,
} from './rendered-design-harness';

vi.mock('@hooks/use-locale', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hooks/use-locale')>()),
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

  it('mounts and disposes the actual compact FileDropzone path used by browser checks', async () => {
    const app = document.createElement('div');
    app.dataset.testid = 'app';
    document.body.appendChild(app);

    const dispose = mountCompactProgressHarness('en');
    await vi.waitFor(() => {
      const harness = document.querySelector('[data-testid="compact-progress-harness"]');
      expect(harness?.querySelector('[role="progressbar"]')?.getAttribute('data-progress')).toBe(
        '84'
      );
      expect(harness?.textContent).toContain('Encoding animation frames');
      expect(harness?.textContent).toContain('64 MB / 512 MB (13%)');
    });

    dispose();
    expect(
      document.querySelector('[data-testid="compact-progress-harness"]')?.childElementCount
    ).toBe(0);
    expect(mountResultPreviewHarness).toBeTypeOf('function');
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

  it.each([false, true])(
    'does not expose the frequently changing container as a live status region (compact=%s)',
    (compact) => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      render(
        () => (
          <ProgressBar compact={compact} progress={42} status="Converting" phase="decoding" />
        ),
        container
      );

      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.querySelector('[aria-live]')).toBeNull();
      expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    }
  );

  it('shows ETA only when a positive estimate is available', () => {
    const withEta = document.createElement('div');
    const withoutEta = document.createElement('div');
    document.body.append(withEta, withoutEta);
    render(
      () => (
        <ProgressBar
          compact
          estimatedSecondsRemaining={42}
          progress={42}
          status="Converting"
        />
      ),
      withEta
    );
    render(
      () => (
        <ProgressBar compact estimatedSecondsRemaining={null} progress={42} status="Converting" />
      ),
      withoutEta
    );

    expect(withEta.textContent).toContain('progress.eta');
    expect(withoutEta.textContent).not.toContain('progress.eta');
  });

  it('suppresses a repeated primary status while preserving distinct progress detail', () => {
    const repeated = document.createElement('div');
    const distinct = document.createElement('div');
    document.body.append(repeated, distinct);
    render(
      () => (
        <ProgressBar
          compact
          progress={42}
          status="Cancelling"
          statusMessage="Cancelling"
        />
      ),
      repeated
    );
    render(
      () => (
        <ProgressBar
          compact
          progress={42}
          status="Converting"
          statusMessage="Encoding frame 42"
        />
      ),
      distinct
    );

    expect(
      Array.from(repeated.querySelectorAll('span')).filter(
        (element) => element.textContent === 'Cancelling'
      )
    ).toHaveLength(1);
    expect(distinct.textContent).toContain('Encoding frame 42');
  });
});
