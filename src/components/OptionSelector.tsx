import { For, type JSX, Show, splitProps } from 'solid-js';
import Tooltip from './Tooltip';
import Icon from './ui/Icon';

const BASE_OPTION_CLASS =
  'relative flex items-center justify-center px-4 py-3 border rounded-lg cursor-pointer transition-colors';
const SELECTED_OPTION_CLASS =
  'bg-blue-50 dark:bg-blue-950 border-blue-500 dark:border-blue-400 text-blue-700 dark:text-blue-300';
const DEFAULT_OPTION_CLASS =
  'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-600';
const DEFAULT_COLUMNS_MANY = 3;
const DEFAULT_COLUMNS_FEW = 2;

type OptionValue = string | number;

export interface OptionSelectorOption<T extends OptionValue> {
  value: T;
  label: string;
  description?: string;
}

interface OptionSelectorProps<T extends OptionValue> {
  title: string;
  name: string;
  value: T;
  options: OptionSelectorOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  columns?: 2 | 3;
  tooltip?: string;
}

const OptionSelector = <T extends OptionValue>(props: OptionSelectorProps<T>) => {
  const [local] = splitProps(props, [
    'title',
    'name',
    'value',
    'options',
    'onChange',
    'disabled',
    'columns',
    'tooltip',
  ]);

  const columns = (): 2 | 3 =>
    local.columns ?? (local.options.length >= 3 ? DEFAULT_COLUMNS_MANY : DEFAULT_COLUMNS_FEW);

  const optionClass = (selected: boolean): string =>
    `${BASE_OPTION_CLASS} ${selected ? SELECTED_OPTION_CLASS : DEFAULT_OPTION_CLASS}`;

  const gridColumnsClass = (): string =>
    columns() === 3 ? 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2';

  const legendId = (): string => `${local.name}-legend`;

  const handleOptionChange = (value: T): void => {
    local.onChange(value);
  };

  const renderOption = (option: OptionSelectorOption<T>): JSX.Element => {
    const descriptionId = option.description ? `${local.name}-${option.value}-desc` : undefined;
    const ariaLabel = option.description ? `${option.label}: ${option.description}` : option.label;

    return (
      <label class={optionClass(option.value === local.value)}>
        <input
          type="radio"
          name={local.name}
          value={String(option.value)}
          checked={option.value === local.value}
          onChange={() => handleOptionChange(option.value)}
          disabled={local.disabled}
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
  };

  const handleTooltipKeyDown: JSX.EventHandlerUnion<HTMLButtonElement, KeyboardEvent> = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.currentTarget.click();
    }
  };

  return (
    <fieldset
      class={`mb-6 ${local.disabled ? 'opacity-50 pointer-events-none' : ''}`}
      disabled={local.disabled}
      aria-label={local.title}
    >
      <legend
        id={legendId()}
        class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2"
      >
        {local.title}
        <Show when={local.tooltip}>
          <Tooltip content={local.tooltip!}>
            <button
              type="button"
              tabIndex={0}
              class="focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
              aria-label={`Information about ${local.title}`}
              onKeyDown={handleTooltipKeyDown}
            >
              <Icon name="info" size="sm" class="text-gray-400 dark:text-gray-600 cursor-help" />
            </button>
          </Tooltip>
        </Show>
      </legend>
      <div
        role="radiogroup"
        aria-labelledby={legendId()}
        class={`grid gap-3 ${gridColumnsClass()}`}
      >
        <For each={local.options}>{renderOption}</For>
      </div>
    </fieldset>
  );
};

export default OptionSelector;
