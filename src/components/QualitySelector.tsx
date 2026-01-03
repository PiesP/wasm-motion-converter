import type { Component } from 'solid-js';
import type { ConversionQuality } from '../types/conversion-types';

interface QualitySelectorProps {
  value: ConversionQuality;
  onChange: (quality: ConversionQuality) => void;
  disabled?: boolean;
}

const QualitySelector: Component<QualitySelectorProps> = (props) => {
  return (
    <div class={`mb-6 ${props.disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      <div class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
        Quality Preset
      </div>
      <div class="grid grid-cols-3 gap-3">
        <label
          class={`relative flex items-center justify-center px-4 py-3 border rounded-lg cursor-pointer transition-colors ${
            props.value === 'low'
              ? 'bg-blue-50 dark:bg-blue-950 border-blue-500 dark:border-blue-400 text-blue-700 dark:text-blue-300'
              : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-600'
          }`}
        >
          <input
            type="radio"
            name="quality"
            value="low"
            checked={props.value === 'low'}
            onChange={() => props.onChange('low')}
            class="sr-only"
          />
          <div class="text-center">
            <div class="font-medium">Low</div>
            <div class="text-xs mt-1 opacity-75">Fast, larger</div>
          </div>
        </label>

        <label
          class={`relative flex items-center justify-center px-4 py-3 border rounded-lg cursor-pointer transition-colors ${
            props.value === 'medium'
              ? 'bg-blue-50 dark:bg-blue-950 border-blue-500 dark:border-blue-400 text-blue-700 dark:text-blue-300'
              : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-600'
          }`}
        >
          <input
            type="radio"
            name="quality"
            value="medium"
            checked={props.value === 'medium'}
            onChange={() => props.onChange('medium')}
            class="sr-only"
          />
          <div class="text-center">
            <div class="font-medium">Medium</div>
            <div class="text-xs mt-1 opacity-75">Balanced</div>
          </div>
        </label>

        <label
          class={`relative flex items-center justify-center px-4 py-3 border rounded-lg cursor-pointer transition-colors ${
            props.value === 'high'
              ? 'bg-blue-50 dark:bg-blue-950 border-blue-500 dark:border-blue-400 text-blue-700 dark:text-blue-300'
              : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-600'
          }`}
        >
          <input
            type="radio"
            name="quality"
            value="high"
            checked={props.value === 'high'}
            onChange={() => props.onChange('high')}
            class="sr-only"
          />
          <div class="text-center">
            <div class="font-medium">High</div>
            <div class="text-xs mt-1 opacity-75">Slow, smaller</div>
          </div>
        </label>
      </div>
    </div>
  );
};

export default QualitySelector;
