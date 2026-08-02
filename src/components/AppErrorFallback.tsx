// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { TFunction } from '@t/i18n-types';
import type { Component } from 'solid-js';

interface AppErrorFallbackProps {
  error: unknown;
  reset: () => void;
  t: TFunction;
}

const AppErrorFallback: Component<AppErrorFallbackProps> = (props) => (
  <div class="flex min-h-screen items-center justify-center bg-bg-base p-4">
    <div class="max-w-2xl border-l-4 border-status-danger/60 bg-bg-elevated p-6 rounded-lg">
      <h2 class="mb-2 text-lg font-semibold text-text-primary">{props.t('app.error.title')}</h2>
      <p class="mb-4 text-sm text-text-secondary">{props.t('app.error.description')}</p>
      <div class="mb-4 flex gap-3">
        <button
          type="button"
          onClick={props.reset}
          class="inline-flex items-center rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg-elevated cursor-pointer"
        >
          {props.t('app.error.retry')}
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          class="inline-flex items-center rounded-md border border-border-standard bg-white/[0.02] px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/[0.2] focus-visible:ring-offset-2 focus-visible:ring-offset-bg-elevated cursor-pointer"
        >
          {props.t('app.error.reload')}
        </button>
      </div>
      <details class="text-xs text-text-secondary">
        <summary class="cursor-pointer hover:underline">{props.t('app.error.details')}</summary>
        <pre class="mt-2 overflow-auto rounded bg-white/[0.02] border border-border-standard p-3">
          {String(props.error)}
        </pre>
      </details>
    </div>
  </div>
);

export default AppErrorFallback;
