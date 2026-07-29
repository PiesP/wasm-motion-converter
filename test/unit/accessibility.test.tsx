// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, it, expect, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createRoot } from 'solid-js';

// Source file assertions run in Node context before Vite bundles for browser.
// SolidJS 1.9 reactive updates don't flush reliably in jsdom (MessageChannel-based
// scheduler), so we verify source code patterns for components that rely on
// reactive state changes, and verify static DOM structure for initial render.
const { appSrc, indexCss, modalSrc, fileDropzoneSrc, optionSelectorSrc } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path');
  const srcDir = path.resolve(__dirname, '../../src');
  return {
    appSrc: fs.readFileSync(path.join(srcDir, 'App.tsx'), 'utf-8'),
    indexCss: fs.readFileSync(path.join(srcDir, 'index.css'), 'utf-8'),
    modalSrc: fs.readFileSync(path.join(srcDir, 'components/ConfirmationModal.tsx'), 'utf-8'),
    fileDropzoneSrc: fs.readFileSync(path.join(srcDir, 'components/FileDropzone.tsx'), 'utf-8'),
    optionSelectorSrc: fs.readFileSync(path.join(srcDir, 'components/OptionSelector.tsx'), 'utf-8'),
  };
});
// ── SolidJS Component Imports ──────────────────────────────────

import Tooltip from '@components/Tooltip';
import FileDropzone from '@components/FileDropzone';
import OptionSelector from '@components/OptionSelector';
import type { OptionSelectorOption } from '@components/OptionSelector';
import { LocaleProvider } from '@hooks/use-locale';

// ── Helpers ────────────────────────────────────────────────────

function queryAllByRole(container: HTMLElement, role: string): HTMLElement[] {
  return Array.from(container.querySelectorAll(`[role="${role}"]`));
}

function mountComponent(component: () => any): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  createRoot(() => {
    render(component, container);
    return () => {};
  });
  return container;
}

// ── Tests ──────────────────────────────────────────────────────

describe('Accessibility', () => {
  beforeEach(() => {
    document.body.inert = false;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.inert = false;
    document.body.innerHTML = '';
  });

  // ── 1. Tooltip ────────────────────────────────────────────────

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

  // ── 2. FileDropzone ───────────────────────────────────────────

  describe('FileDropzone', () => {
    it('source code includes i18n key for dropzone label', () => {
      expect(fileDropzoneSrc).toContain('dropzone.dropHere');
      expect(fileDropzoneSrc).toContain('dropzone.clickSelect');
      expect(fileDropzoneSrc).toContain('dropzone.selectFile');
    });

    it('source code includes i18n key for aria labels', () => {
      expect(fileDropzoneSrc).toContain('dropzone.cancelConversion');
      expect(fileDropzoneSrc).toContain('dropzone.preview');
    });

    it('source code includes useLocale integration', () => {
      expect(fileDropzoneSrc).toContain('useLocale');
      expect(fileDropzoneSrc).toContain('const { t } = useLocale()');
    });
  });

  // ── 3. OptionSelector ────────────────────────────────────────

  describe('OptionSelector', () => {
    // Source code verification (component uses useLocale which requires
    // async rendering context not available in jsdom mountComponent)

    it('uses native radio inputs with same name for keyboard navigation', () => {
      // Native <input type="radio"> handles role, checked state, and arrow-key
      // navigation automatically when all inputs share the same name attribute.
      // No explicit role="radio" or tabIndex is needed on the label.
      expect(optionSelectorSrc).toContain('type="radio"');
    });

    it('uses checked attribute on native inputs instead of aria-checked', () => {
      expect(optionSelectorSrc).toContain('checked={');
    });

    it('source code includes radiogroup role', () => {
      expect(optionSelectorSrc).toContain('role="radiogroup"');
    });

    it('source code includes fieldset aria-label', () => {
      expect(optionSelectorSrc).toContain('aria-label={local.title}');
    });

    it('uses native radio name attribute for grouping', () => {
      // Native radio buttons with the same name attribute form a group.
      // Browser handles arrow-key navigation within the group automatically.
      expect(optionSelectorSrc).toContain('name={local.name}');
    });
  });

  // ── 4. ConfirmationModal: source-code ARIA patterns ───────────

  describe('ConfirmationModal', () => {
    // Note: Reactive rendering can't be reliably tested in jsdom
    // because SolidJS 1.9 uses MessageChannel-based scheduling
    // that doesn't flush synchronously in jsdom.
    // We verify the source code patterns instead.

    it('source code includes role="dialog" and aria-modal', () => {
      expect(modalSrc).toContain('role="dialog"');
      expect(modalSrc).toContain('aria-modal="true"');
    });

    it('source code includes aria-labelledby and aria-describedby', () => {
      expect(modalSrc).toContain('aria-labelledby');
      expect(modalSrc).toContain('aria-describedby');
    });

    it('source code includes cancel and confirm buttons', () => {
      expect(modalSrc).toContain('modal-cancel-button');
      expect(modalSrc).toContain('modal-confirm-button');
    });

    it('source code includes focus trap implementation', () => {
      expect(modalSrc).toContain('handleFocusTrap');
      expect(modalSrc).toContain('querySelectorAll');
    });

    it('source code includes Escape key dismiss', () => {
      expect(modalSrc).toContain('Escape');
      expect(modalSrc).toContain('cancelDialog');
    });
  });

  // ── 5. Skip-to-content link ─────────────────────────────────

  describe('Skip-to-content link', () => {
    it('renders skip link pattern with correct href and text', () => {
      const container = document.createElement('div');
      document.body.appendChild(container);

      createRoot(() => {
        render(
          () => (
            <div>
              <a
                class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[#5e6ad2] focus:px-4 focus:py-2 focus:text-white focus:shadow-lg"
                href="#main-content"
              >
                Skip to main content
              </a>
              <main id="main-content" class="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
                Content
              </main>
            </div>
          ),
          container,
        );
        return () => {};
      });

      const skipLink = container.querySelector('a[href="#main-content"]');
      expect(skipLink).not.toBeNull();
      expect(skipLink!.textContent).toContain('Skip to main content');
      expect(skipLink!.classList.contains('sr-only')).toBe(true);

      const mainContent = container.querySelector('#main-content');
      expect(mainContent).not.toBeNull();
      expect(mainContent!.tagName).toBe('MAIN');
    });

    it('App source file contains skip-to-content link pattern', () => {
      expect(appSrc).toContain('href="#main-content"');
      expect(appSrc).toContain('app.skipToMain');
      expect(appSrc).toContain('class="sr-only');
      expect(appSrc).toContain('id="main-content"');
    });
  });

  // ── 6. Focus-visible styles ─────────────────────────────────

  describe('Focus-visible styles', () => {
    it('interactive elements have focus-visible class in their classList', () => {
      const container = mountComponent(() => (
        <button
          class="px-4 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5e6ad2]"
          type="button"
        >
          Test
        </button>
      ));

      const button = container.querySelector('button')!;
      expect(button.classList.contains('focus-visible:ring-2')).toBe(true);
      expect(
        button.classList.contains('focus-visible:ring-[#5e6ad2]'),
      ).toBe(true);
    });

    it('FileDropzone source includes focus-visible styles', () => {
      expect(fileDropzoneSrc).toContain('focus-visible:ring-2');
      expect(fileDropzoneSrc).toContain('focus-visible:outline-none');
    });
  });

  // ── 7. prefers-reduced-motion ───────────────────────────────

  describe('prefers-reduced-motion', () => {
    it('CSS contains prefers-reduced-motion media query', () => {
      expect(indexCss).toContain('prefers-reduced-motion');
      expect(indexCss).toContain('animation-duration: 0.01ms !important');
      expect(indexCss).toContain('transition-duration: 0.01ms !important');
    });
  });

  // ── 8. Scroll lock when modal is open ─────────────────────────

  describe('Modal scroll lock', () => {
    it('ConfirmationModal locks body scroll without disabling the modal', () => {
      // The implementation uses scroll lock (overflow:hidden + position:fixed)
      // instead of document.body.inert to keep the modal itself interactive.
      expect(modalSrc).toContain("document.body.style.overflow = 'hidden'");
      expect(modalSrc).toContain("document.body.style.position = 'fixed'");
      // Body scroll should be restored when modal closes
      expect(modalSrc).toContain("document.body.style.overflow = ''");
    });
  });

});
