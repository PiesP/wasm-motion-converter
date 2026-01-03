import { For, Show } from 'solid-js';

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
}

const baseOptionClass =
  'relative flex items-center justify-center px-4 py-3 border rounded-lg cursor-pointer transition-colors';
const selectedOptionClass =
  'bg-blue-50 dark:bg-blue-950 border-blue-500 dark:border-blue-400 text-blue-700 dark:text-blue-300';
const defaultOptionClass =
  'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-600';

const OptionSelector = <T extends OptionValue,>(props: OptionSelectorProps<T>) => {
  const columns = () => props.columns ?? (props.options.length >= 3 ? 3 : 2);
  const optionClass = (selected: boolean) =>
    `${baseOptionClass} ${selected ? selectedOptionClass : defaultOptionClass}`;

  return (
    <div class={`mb-6 ${props.disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      <div class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
        {props.title}
      </div>
      <div class={`grid gap-3 ${columns() === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <For each={props.options}>
          {(option) => (
            <label class={optionClass(option.value === props.value)}>
              <input
                type="radio"
                name={props.name}
                value={String(option.value)}
                checked={option.value === props.value}
                onChange={() => props.onChange(option.value)}
                disabled={props.disabled}
                class="sr-only"
              />
              <div class="text-center">
                <div class="font-medium">{option.label}</div>
                <Show when={option.description}>
                  <div class="text-xs mt-1 opacity-75">{option.description}</div>
                </Show>
              </div>
            </label>
          )}
        </For>
      </div>
    </div>
  );
};

export default OptionSelector;
