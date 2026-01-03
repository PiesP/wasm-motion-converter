import type { Component } from 'solid-js';
import type { ConversionFormat } from '../types/conversion-types';

interface FormatSelectorProps {
  value: ConversionFormat;
  onChange: (format: ConversionFormat) => void;
  disabled?: boolean;
}

const FormatSelector: Component<FormatSelectorProps> = (props) => {
  return (
    <div class={`mb-6 ${props.disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      <div class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
        Output Format
      </div>
      <div class="grid grid-cols-2 gap-3">
        <label
          class={`relative flex items-center justify-center px-4 py-3 border rounded-lg cursor-pointer transition-colors ${
            props.value === 'gif'
              ? 'bg-blue-50 dark:bg-blue-950 border-blue-500 dark:border-blue-400 text-blue-700 dark:text-blue-300'
              : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-600'
          }`}
        >
          <input
            type="radio"
            name="format"
            value="gif"
            checked={props.value === 'gif'}
            onChange={() => props.onChange('gif')}
            class="sr-only"
          />
          <div class="text-center">
            <div class="font-medium">GIF</div>
            <div class="text-xs mt-1 opacity-75">Universal support</div>
          </div>
        </label>

        <label
          class={`relative flex items-center justify-center px-4 py-3 border rounded-lg cursor-pointer transition-colors ${
            props.value === 'webp'
              ? 'bg-blue-50 dark:bg-blue-950 border-blue-500 dark:border-blue-400 text-blue-700 dark:text-blue-300'
              : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-600'
          }`}
        >
          <input
            type="radio"
            name="format"
            value="webp"
            checked={props.value === 'webp'}
            onChange={() => props.onChange('webp')}
            class="sr-only"
          />
          <div class="text-center">
            <div class="font-medium">WebP</div>
            <div class="text-xs mt-1 opacity-75">Smaller file size</div>
          </div>
        </label>
      </div>
    </div>
  );
};

export default FormatSelector;
