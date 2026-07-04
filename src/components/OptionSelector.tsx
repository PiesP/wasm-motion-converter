// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { JSX } from 'solid-js';
import { For, Show, splitProps } from 'solid-js';
import Tooltip from './Tooltip';
import Icon from './ui/Icon';

const BASE_OPTION_CLASS =
  'relative flex items-center justify-center px-3 py-2 sm:py-3 border rounded-lg cursor-pointer transition-all duration-200 text-sm min-h-[44px]';
const SELECTED_OPTION_CLASS =
  'bg-[#5e6ad2]/20 border-[#5e6ad2] text-[#f7f8f8] ring-2 ring-[#5e6ad2]/30';
const DEFAULT_OPTION_CLASS =
  'bg-white/[0.02] border-white/[0.08] text-[#d0d6e0] hover:border-white/[0.15] hover:bg-white/[0.04]';
const DEFAULT_COLUMNS_MANY = 3;
const DEFAULT_COLUMNS_FEW = 2;

type OptionValue = string | number;

export interface OptionSelectorOption<T extends OptionValue> {
  value: T;
  label: string;
  description?: string | undefined;
}

interface OptionSelectorProps<T extends OptionValue> {
  title: string;
  name: string;
  value: T;
  options: OptionSelectorOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean | undefined;
  columns?: (2 | 3) | undefined;
  tooltip?: string | undefined;
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
    columns() === 3 ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-2';

  const legendId = (): string => `${local.name}-legend`;

  const handleOptionChange = (value: T): void => {
    local.onChange(value);
  };

  const renderOption = (option: OptionSelectorOption<T>): JSX.Element => {
    const inputId = `${local.name}-${String(option.value)}`;
    const descriptionId = option.description ? `${inputId}-desc` : undefined;
    const ariaLabel = option.label;

    return (
      <label
        for={inputId}
        class={`${optionClass(option.value === local.value)} relative`}
        data-testid={`option-${local.name}-${String(option.value)}`}
        aria-label={ariaLabel}
      >
        <input
          type="radio"
          id={inputId}
          name={local.name}
          value={String(option.value)}
          checked={option.value === local.value}
          onChange={() => handleOptionChange(option.value)}
          disabled={local.disabled}
          class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          aria-describedby={descriptionId}
        />
        <div class="text-center pointer-events-none">
          <div class="font-medium">{option.label}</div>
          <Show when={option.description}>
            <div id={descriptionId} class="text-[10px] mt-0.5 opacity-75">
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
      data-testid={`option-group-${local.name}`}
    >
      <legend
        id={legendId()}
        class="block text-xs font-medium text-[#8a8f98] mb-2 flex items-center gap-1.5"
      >
        <span>{local.title}</span>
        <Show when={local.tooltip}>
          <Tooltip content={local.tooltip!}>
            <button
              type="button"
              tabIndex={0}
              class="inline-flex items-center justify-center w-11 h-11 -m-2 min-h-[44px] focus:outline-none focus:ring-2 focus:ring-[rgba(94,106,210,0.5)] rounded-md"
              aria-label={`Information about ${local.title}`}
              onKeyDown={handleTooltipKeyDown}
            >
              <Icon name="info" size="sm" class="text-[#62666d] cursor-help" />
            </button>
          </Tooltip>
        </Show>
      </legend>
      <div
        role="radiogroup"
        aria-labelledby={legendId()}
        class={`grid gap-2 ${gridColumnsClass()}`}
      >
        <For each={local.options}>{renderOption}</For>
      </div>
    </fieldset>
  );
};

export default OptionSelector;
