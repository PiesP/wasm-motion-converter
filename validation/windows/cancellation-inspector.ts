// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { Page } from '@playwright/test';

type CancellationSample = {
  values: number[];
  ariaValueNow: string | null;
  sameProgressElement: boolean;
};
type CancellationObservation = {
  stateText: string;
  progressBeforeClick: number;
  sameProgressElement: boolean;
  progressValues: number[];
  progressSamples: CancellationSample[];
  sampleOverflow: boolean;
  visibleProgressBarCount: number;
  legacyProgressCount: number;
  settingsCancel: { disabled: boolean | undefined; label: string | null };
  dropzoneCancel: { disabled: boolean | undefined; label: string | null };
  dropzoneBusy: string | null;
  progressBusy: string | null;
  progressAriaValueNow: string | null;
  diagnosticsCount: number;
  diagnosticsOpen: boolean | null;
  diagnosticsSummaryFontSizePx: number | null;
  statusFontSizePx: number | null;
};
type InspectorPage = Pick<Page, 'evaluate'>;
declare global {
  var __wmcCancellationInspector:
    | {
        progressBar: HTMLElement;
        progress: number;
        observation: CancellationObservation | null;
        observer: MutationObserver | null;
      }
    | undefined;
}

export async function installCancellationInspector(page: InspectorPage) {
  return page.evaluate(() => {
    const visible = (element: Element) =>
      element instanceof HTMLElement && element.getClientRects().length > 0;
    const progressBars = [...document.querySelectorAll('[role="progressbar"]')].filter(visible);
    const progressBar = progressBars[0];
    const progress = Number(progressBar?.getAttribute('data-progress'));
    if (!(progressBar instanceof HTMLElement) || progressBars.length !== 1 || !(progress > 0)) {
      throw new Error('Cancellation inspector requires one visible non-zero progress bar');
    }

    const inspector: NonNullable<typeof globalThis.__wmcCancellationInspector> = {
      progressBar,
      progress,
      observation: null,
      observer: null,
    };
    const capture = () => {
      const stateText = document.querySelector('#app-state')?.textContent?.trim() ?? '';
      if (!stateText.toLowerCase().startsWith('cancelling')) return;
      const currentProgressBars = [...document.querySelectorAll('[role="progressbar"]')].filter(
        visible
      );
      const progressSample = {
        values: currentProgressBars.map((element) => Number(element.getAttribute('data-progress'))),
        ariaValueNow: currentProgressBars[0]?.getAttribute('aria-valuenow') ?? null,
        sameProgressElement: currentProgressBars[0] === inspector.progressBar,
      };
      if (inspector.observation) {
        const samples = inspector.observation.progressSamples;
        const previous = samples.at(-1);
        if (
          !previous ||
          previous.values.length !== progressSample.values.length ||
          previous.values.some((value, index) => value !== progressSample.values[index]) ||
          previous.ariaValueNow !== progressSample.ariaValueNow ||
          previous.sameProgressElement !== progressSample.sameProgressElement
        ) {
          if (samples.length < 128) samples.push(progressSample);
          else inspector.observation.sampleOverflow = true;
        }
        return;
      }
      const settingsCancel = document.querySelector('[data-testid="stop-conversion-button"]');
      const dropzoneCancel = document.querySelector('[data-testid="dropzone-cancel-button"]');
      const dropzone = document.querySelector('[data-testid="dropzone"]');
      const progressBusyRegion = currentProgressBars[0]?.closest('[aria-busy]');
      const diagnostics = dropzone?.querySelector('[data-testid="progress-diagnostics"]');
      const diagnosticsSummary = diagnostics?.querySelector('summary');
      const statusMessage = dropzone?.querySelector('[data-testid="progress-status-message"]');
      inspector.observation = {
        stateText,
        progressBeforeClick: inspector.progress,
        sameProgressElement: progressSample.sameProgressElement,
        progressValues: progressSample.values,
        progressSamples: [progressSample],
        sampleOverflow: false,
        visibleProgressBarCount: currentProgressBars.length,
        legacyProgressCount: document.querySelectorAll('[data-testid="conversion-progress"]')
          .length,
        settingsCancel: {
          disabled:
            settingsCancel instanceof HTMLButtonElement ? settingsCancel.disabled : undefined,
          label: settingsCancel?.getAttribute('aria-label') ?? null,
        },
        dropzoneCancel: {
          disabled:
            dropzoneCancel instanceof HTMLButtonElement ? dropzoneCancel.disabled : undefined,
          label: dropzoneCancel?.getAttribute('aria-label') ?? null,
        },
        dropzoneBusy: dropzone?.getAttribute('aria-busy') ?? null,
        progressBusy:
          progressBusyRegion &&
          progressBusyRegion !== dropzone &&
          dropzone?.contains(progressBusyRegion)
            ? progressBusyRegion.getAttribute('aria-busy')
            : null,
        progressAriaValueNow: progressSample.ariaValueNow,
        diagnosticsCount:
          dropzone?.querySelectorAll('[data-testid="progress-diagnostics"]').length ?? 0,
        diagnosticsOpen: diagnostics instanceof HTMLDetailsElement ? diagnostics.open : null,
        diagnosticsSummaryFontSizePx: diagnosticsSummary
          ? Number.parseFloat(getComputedStyle(diagnosticsSummary).fontSize)
          : null,
        statusFontSizePx: statusMessage
          ? Number.parseFloat(getComputedStyle(statusMessage).fontSize)
          : null,
      };
    };
    const observer = new MutationObserver(capture);
    inspector.observer = observer;
    observer.observe(document.body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    globalThis.__wmcCancellationInspector = inspector;
    return progress;
  });
}

export async function readCancellationInspector(page: InspectorPage) {
  return page.evaluate(() => {
    const inspector = globalThis.__wmcCancellationInspector;
    inspector?.observer?.disconnect();
    Reflect.deleteProperty(globalThis, '__wmcCancellationInspector');
    return inspector?.observation ?? null;
  });
}
