// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import ConfirmationModal from '@components/ConfirmationModal';
import FileDropzone from '@components/FileDropzone';
import OptionSelector from '@components/OptionSelector';
import Tooltip from '@components/Tooltip';
import {
  dismissConfirmation,
  getConfirmationState,
  showConfirmation,
} from '@stores/confirmation-store';
import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@hooks/use-locale', () => ({
  useLocale: () => ({
    locale: () => 'en',
    t: (key: string) => key,
  }),
}));

const disposers: Array<() => void> = [];

function mountComponent(component: () => JSX.Element): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  disposers.push(render(component, container));
  return container;
}

describe('Accessibility', () => {
  beforeEach(() => {
    dismissConfirmation();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    dismissConfirmation();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('Tooltip', () => {
    it('puts aria-describedby on the focusable trigger itself', () => {
      const container = mountComponent(() => (
        <Tooltip content="Helpful info">
          {(triggerProps) => (
            <button {...triggerProps} type="button">
              Hover me
            </button>
          )}
        </Tooltip>
      ));

      const trigger = container.querySelector('button');
      expect(trigger?.getAttribute('aria-describedby')).toMatch(/^tooltip-/);
      expect(trigger?.parentElement?.hasAttribute('aria-describedby')).toBe(false);
    });

    it('renders the referenced tooltip while the trigger has focus', () => {
      const container = mountComponent(() => (
        <Tooltip content="Helpful info">
          {(triggerProps) => (
            <button {...triggerProps} type="button">
              Hover me
            </button>
          )}
        </Tooltip>
      ));

      const trigger = container.querySelector<HTMLButtonElement>('button')!;
      const describedBy = trigger.getAttribute('aria-describedby');
      trigger.focus();

      const tooltip = container.querySelector<HTMLElement>(`#${describedBy}`);
      expect(tooltip?.getAttribute('role')).toBe('tooltip');
      expect(tooltip?.textContent).toContain('Helpful info');
    });

    it('dismisses the tooltip when Escape is pressed', () => {
      const container = mountComponent(() => (
        <Tooltip content="Helpful info">
          {(triggerProps) => (
            <button {...triggerProps} type="button">
              Hover me
            </button>
          )}
        </Tooltip>
      ));

      const trigger = container.querySelector<HTMLButtonElement>('button')!;
      trigger.focus();
      expect(container.querySelector('[role="tooltip"]')).not.toBeNull();

      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(container.querySelector('[role="tooltip"]')).toBeNull();
    });
  });

  describe('FileDropzone', () => {
    it('renders translated labels on the interactive controls', () => {
      const container = mountComponent(() => <FileDropzone onFileSelected={() => {}} />);
      const dropzone = container.querySelector<HTMLElement>('[data-testid="dropzone"]')!;
      const chooseButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="choose-file-button"]'
      )!;
      const fileInput = container.querySelector<HTMLInputElement>('[data-testid="file-input"]')!;

      expect(dropzone.getAttribute('role')).toBe('group');
      expect(dropzone.getAttribute('aria-label')).toBe('dropzone.selectFile');
      expect(chooseButton.textContent).toContain('dropzone.dropHere');
      expect(fileInput.getAttribute('aria-label')).toBe('dropzone.selectFile');
      expect(container.textContent).toContain('dropzone.clickSelect');
    });

    it('labels the preview and cancel action during conversion', () => {
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
      const container = mountComponent(() => (
        <FileDropzone
          onFileSelected={() => {}}
          onCancel={() => {}}
          previewUrl="blob:preview"
          status="Converting"
        />
      ));

      expect(container.querySelector('video')?.getAttribute('aria-label')).toBe('dropzone.preview');
      expect(
        container
          .querySelector('[data-testid="dropzone-cancel-button"]')
          ?.getAttribute('aria-label')
      ).toBe('dropzone.cancelConversion');
    });
  });

  describe('OptionSelector', () => {
    it('renders one named native radio group and reports changes', () => {
      const onChange = vi.fn();
      const container = mountComponent(() => (
        <OptionSelector
          title="Quality"
          name="quality"
          value="medium"
          options={[
            { value: 'low', label: 'Low', description: 'Small output' },
            { value: 'medium', label: 'Medium', description: 'Balanced output' },
          ]}
          onChange={onChange}
        />
      ));
      const fieldset = container.querySelector('fieldset')!;
      const radioGroup = container.querySelector<HTMLElement>('[role="radiogroup"]')!;
      const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));

      expect(fieldset.getAttribute('aria-label')).toBe('Quality');
      expect(radioGroup.getAttribute('aria-labelledby')).toBe('quality-legend');
      expect(radios).toHaveLength(2);
      expect(radios.map((radio) => radio.name)).toEqual(['quality', 'quality']);
      expect(radios[0]?.checked).toBe(false);
      expect(radios[1]?.checked).toBe(true);
      expect(radios[1]?.getAttribute('aria-describedby')).toBe('quality-medium-desc');

      radios[0]?.click();
      expect(onChange).toHaveBeenCalledWith('low');
    });
  });

  describe('ConfirmationModal', () => {
    it('exposes dialog relationships, traps focus, dismisses with Escape, and restores state', async () => {
      vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
      const previous = document.createElement('button');
      document.body.append(previous);
      previous.focus();
      const onCancel = vi.fn();
      const container = mountComponent(() => <ConfirmationModal />);

      showConfirmation(
        [
          {
            severity: 'warning',
            message: 'Large file',
            details: 'Conversion may take longer',
            requiresConfirmation: true,
          },
        ],
        vi.fn(),
        onCancel
      );
      await Promise.resolve();

      const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
      const cancelButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="modal-cancel-button"]'
      )!;
      const confirmButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="modal-confirm-button"]'
      )!;

      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.getAttribute('aria-labelledby')).toBe('modal-title');
      expect(dialog.getAttribute('aria-describedby')).toBe('modal-description');
      expect(container.querySelector('#modal-title')?.textContent).toBe('modal.title');
      expect(container.querySelector('#modal-description')?.textContent).toContain('Large file');
      expect(cancelButton.getAttribute('aria-label')).toBe('modal.cancel');
      expect(confirmButton.getAttribute('aria-label')).toBe('modal.confirm');
      expect(document.body.style.overflow).toBe('hidden');
      expect(document.body.style.position).toBe('fixed');
      expect(document.activeElement).toBe(cancelButton);

      confirmButton.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      expect(document.activeElement).toBe(cancelButton);
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
      );
      expect(document.activeElement).toBe(confirmButton);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();

      expect(onCancel).toHaveBeenCalledOnce();
      expect(getConfirmationState().isVisible).toBe(false);
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(document.body.style.overflow).toBe('');
      expect(document.body.style.position).toBe('');
      expect(document.activeElement).toBe(previous);
    });
  });

});
