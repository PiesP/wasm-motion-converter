import { type Component, createMemo, For, Show } from 'solid-js';
import type { PerformanceWarning, PerformanceWarningSeverity } from '../types/conversion-types';

interface EstimateSummary {
  sizeLabel: string;
  etaLabel?: string;
}

interface InlineWarningBannerProps {
  warnings: PerformanceWarning[];
  actionLabel?: string;
  onAction?: () => void;
  autoApplied?: boolean;
  estimates?: EstimateSummary | null;
}

const InlineWarningBanner: Component<InlineWarningBannerProps> = (props) => {
  // Determine highest severity for styling
  const highestSeverity = createMemo<PerformanceWarningSeverity>(() => {
    if (props.warnings.some((w) => w.severity === 'critical')) return 'critical';
    if (props.warnings.some((w) => w.severity === 'high')) return 'high';
    return 'warning';
  });

  // Consolidated severity-based styles
  const severityStyles = createMemo(() => {
    const severity = highestSeverity();
    switch (severity) {
      case 'critical':
        return {
          container:
            'bg-red-50 dark:bg-red-950 border-l-4 border-red-400 dark:border-red-500 rounded-lg p-4',
          icon: 'h-5 w-5 text-red-400 dark:text-red-500',
          title: 'text-sm font-medium text-red-800 dark:text-red-300',
          text: 'mt-2 text-sm text-red-700 dark:text-red-400',
          button:
            'inline-flex items-center px-3 py-2 border border-transparent text-xs font-medium rounded-md text-red-900 bg-red-200 hover:bg-red-300 dark:text-red-100 dark:bg-red-800 dark:hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 dark:focus:ring-offset-gray-900',
          titleText: 'Critical Performance Issue',
        };
      case 'high':
        return {
          container:
            'bg-orange-50 dark:bg-orange-950 border-l-4 border-orange-400 dark:border-orange-500 rounded-lg p-4',
          icon: 'h-5 w-5 text-orange-400 dark:text-orange-500',
          title: 'text-sm font-medium text-orange-800 dark:text-orange-300',
          text: 'mt-2 text-sm text-orange-700 dark:text-orange-400',
          button:
            'inline-flex items-center px-3 py-2 border border-transparent text-xs font-medium rounded-md text-orange-900 bg-orange-200 hover:bg-orange-300 dark:text-orange-100 dark:bg-orange-800 dark:hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500 dark:focus:ring-offset-gray-900',
          titleText: 'Performance Warning',
        };
      default:
        return {
          container:
            'bg-yellow-50 dark:bg-yellow-950 border-l-4 border-yellow-400 dark:border-yellow-500 rounded-lg p-4',
          icon: 'h-5 w-5 text-yellow-400 dark:text-yellow-500',
          title: 'text-sm font-medium text-yellow-800 dark:text-yellow-300',
          text: 'mt-2 text-sm text-yellow-700 dark:text-yellow-400',
          button:
            'inline-flex items-center px-3 py-2 border border-transparent text-xs font-medium rounded-md text-yellow-900 bg-yellow-200 hover:bg-yellow-300 dark:text-yellow-100 dark:bg-yellow-800 dark:hover:bg-yellow-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-500 dark:focus:ring-offset-gray-900',
          titleText: 'Performance Notice',
        };
    }
  });

  return (
    <div class={severityStyles().container} role="alert" aria-live="polite">
      <div class="flex items-start">
        <div class="flex-shrink-0">
          <svg
            class={severityStyles().icon}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <div class="ml-3 flex-1">
          <div class="flex items-center gap-2">
            <h3 class={severityStyles().title}>{severityStyles().titleText}</h3>
            <Show when={props.autoApplied}>
              <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                ✓ Settings Applied
              </span>
            </Show>
          </div>
          <div class={severityStyles().text}>
            <p class="mb-2">
              Your video may result in slow conversion or large output files
              {highestSeverity() === 'critical' ? ' and could cause browser crashes' : ''}:
            </p>
            <ul class="list-disc list-inside space-y-1">
              <For each={props.warnings}>
                {(warning) => (
                  <li>
                    <strong>{warning.message}</strong> - {warning.recommendation}
                  </li>
                )}
              </For>
            </ul>
            <Show when={props.estimates}>
              <div class="mt-3 space-y-1 text-xs">
                <p>
                  Estimated output size: <strong>{props.estimates?.sizeLabel}</strong>
                  <Show when={props.estimates?.etaLabel}>
                    {' · '}Estimated conversion time: <strong>{props.estimates?.etaLabel}</strong>
                  </Show>
                </p>
              </div>
            </Show>
            <Show when={props.onAction && props.actionLabel}>
              <div class="mt-3">
                <button type="button" class={severityStyles().button} onClick={props.onAction}>
                  {props.actionLabel}
                </button>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InlineWarningBanner;
