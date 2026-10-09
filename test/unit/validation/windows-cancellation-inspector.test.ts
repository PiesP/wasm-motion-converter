import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error The Windows acceptance profile is an executable JavaScript module.
import { installCancellationInspector, readCancellationInspector } from '../../../validation/windows/profile.mjs';

const page = { evaluate: async <T>(callback: () => T): Promise<T> => callback() };

function prepareProgress(): HTMLElement {
  document.body.innerHTML = `
    <div id="app-state">Converting...</div>
    <div data-testid="dropzone">
      <div role="progressbar" data-progress="76" aria-valuenow="76"></div>
    </div>`;
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  const progress = document.querySelector<HTMLElement>('[role="progressbar"]');
  if (!progress) throw new Error('Missing test progress bar');
  return progress;
}

async function enterCancelling(progress: HTMLElement, value: number): Promise<void> {
  progress.setAttribute('data-progress', String(value));
  progress.setAttribute('aria-valuenow', String(value));
  const state = document.querySelector('#app-state');
  if (!state) throw new Error('Missing test state');
  state.textContent = 'Cancelling...';
  await Promise.resolve();
}

afterEach(async () => {
  await readCancellationInspector(page);
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Windows cancellation inspector', () => {
  it('uses the first cancelling-state value after pre-click progress advances', async () => {
    const progress = prepareProgress();
    expect(await installCancellationInspector(page)).toBe(76);

    await enterCancelling(progress, 81);
    const observation = await readCancellationInspector(page);

    expect(observation.progressBeforeClick).toBe(76);
    expect(observation.progressValues).toEqual([81]);
    expect(observation.progressSamples).toEqual([{
      values: [81],
      ariaValueNow: '81',
      sameProgressElement: true,
    }]);
  });

  it('records a value change during cancellation so the freeze assertion fails', async () => {
    const progress = prepareProgress();
    await installCancellationInspector(page);
    await enterCancelling(progress, 81);

    progress.setAttribute('data-progress', '82');
    progress.setAttribute('aria-valuenow', '82');
    await Promise.resolve();
    const observation = await readCancellationInspector(page);

    expect(observation.progressSamples).toEqual([
      { values: [81], ariaValueNow: '81', sameProgressElement: true },
      { values: [82], ariaValueNow: '82', sameProgressElement: true },
    ]);
  });
});
