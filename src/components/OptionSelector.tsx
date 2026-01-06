import { For, Show } from 'solid-js';
import Icon from './ui/Icon';
import Tooltip from './Tooltip';

/**
 * Base CSS classes for option elements
 */
const BASE_OPTION_CLASS =
  'relative flex items-center justify-center px-4 py-3 border rounded-lg cursor-pointer transition-colors';

/**
 * CSS classes for selected option state
 */
const SELECTED_OPTION_CLASS =
  'bg-blue-50 dark:bg-blue-950 border-blue-500 dark:border-blue-400 text-blue-700 dark:text-blue-300';

/**
 * CSS classes for default (unselected) option state
 */
const DEFAULT_OPTION_CLASS =
  'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-600';

/**
 * Default column count when displaying 3+ options
 */
const DEFAULT_COLUMNS_MANY = 3;

/**
 * Default column count when displaying fewer than 3 options
 */
const DEFAULT_COLUMNS_FEW = 2;

/**
 * Allowed option value types
 */
type OptionValue = string | number;

/**
 * Configuration for a single option in the selector
 */
export interface OptionSelectorOption<T extends OptionValue> {
  /** The value of the option */
  value: T;
  /** Display label for the option */
  label: string;
  /** Optional descriptive text shown below the label */
  description?: string;
}

/**
 * Option selector component props
 */
interface OptionSelectorProps<T extends OptionValue> {
  /** Title displayed above the selector */
  title: string;
  /** Name attribute for the radio group */
  name: string;
  /** Currently selected value */
  value: T;
  /** Array of available options */
  options: OptionSelectorOption<T>[];
  /** Callback when option is selected */
  onChange: (value: T) => void;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** Number of columns (2 or 3) for grid layout */
  columns?: 2 | 3;
  /** Optional tooltip text shown next to title */
  tooltip?: string;
}

/**
 * Generic option selector component with radio button grid
 *
 * Displays a set of options in a responsive grid layout with radio button semantics.
 * Supports 2 or 3 column layouts, optional descriptions, and tooltips.
 * Fully accessible with proper ARIA attributes and keyboard navigation.
 *
 * @example
 * ```tsx
 * <OptionSelector
 *   title="Quality"
 *   name="quality"
 *   value={selectedQuality}
 *   options={[
 *     { value: 'low', label: 'Low', description: 'Faster' },
 *     { value: 'high', label: 'High', description: 'Better' }
 *   ]}
 *   onChange={(value) => setQuality(value)}
 * />
 * ```
 */
const OptionSelector = <T extends OptionValue>(props: OptionSelectorProps<T>) => {
  const columns = (): 2 | 3 =>
    props.columns ?? (props.options.length >= 3 ? DEFAULT_COLUMNS_MANY : DEFAULT_COLUMNS_FEW);

  const optionClass = (selected: boolean): string =>
    `${BASE_OPTION_CLASS} ${selected ? SELECTED_OPTION_CLASS : DEFAULT_OPTION_CLASS}`;

  const gridColumnsClass = (): string =>
    columns() === 3 ? 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2';

  return (
    <fieldset
      class={`mb-6 ${props.disabled ? 'opacity-50 pointer-events-none' : ''}`}
      disabled={props.disabled}
      aria-label={props.title}
    >
      <legend class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
        {props.title}
        <Show when={props.tooltip}>
          <Tooltip content={props.tooltip!}>
            <button
              type="button"
              tabIndex={0}
              class="focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
              aria-label={`Information about ${props.title}`}
            >
              <Icon name="info" size="sm" class="text-gray-400 dark:text-gray-600 cursor-help" />
            </button>
          </Tooltip>
        </Show>
      </legend>
      <div
        role="radiogroup"
        aria-labelledby={props.name}
        class={`grid gap-3 ${gridColumnsClass()}`}
      >
        <For each={props.options}>
          {(option) => {
            const descriptionId = option.description
              ? `${props.name}-${option.value}-desc`
              : undefined;
            const ariaLabel = option.description
              ? `${option.label}: ${option.description}`
              : option.label;

            return (
              <label class={optionClass(option.value === props.value)}>
                <input
                  type="radio"
                  name={props.name}
                  value={String(option.value)}
                  checked={option.value === props.value}
                  onChange={() => props.onChange(option.value)}
                  disabled={props.disabled}
                  class="sr-only"
                  aria-label={ariaLabel}
                  aria-describedby={descriptionId}
                />
                <div class="text-center">
                  <div class="font-medium">{option.label}</div>
                  <Show when={option.description}>
                    <div id={descriptionId} class="text-xs mt-1 opacity-75">
                      {option.description}
                    </div>
                  </Show>
                </div>
              </label>
            );
          }}
        </For>
      </div>
    </fieldset>
  );
};

export default OptionSelector;
