import { type Component, Show } from 'solid-js';
import type { ConversionScale, VideoMetadata } from '../types/conversion-types';

interface ScaleSelectorProps {
  value: ConversionScale;
  onChange: (scale: ConversionScale) => void;
  inputMetadata: VideoMetadata | null;
  disabled?: boolean;
}

const ScaleSelector: Component<ScaleSelectorProps> = (props) => {
  const getOutputResolution = (scale: ConversionScale) => {
    if (!props.inputMetadata) return null;
    const width = Math.round(props.inputMetadata.width * scale);
    const height = Math.round(props.inputMetadata.height * scale);
    return `${width}x${height}`;
  };

  return (
    <div class={`mb-6 ${props.disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      <div class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
        Output Scale
      </div>
      <div class="grid grid-cols-3 gap-3">
        <label
          class={`relative flex items-center justify-center px-4 py-3 border rounded-lg cursor-pointer transition-colors ${
            props.value === 0.5
              ? 'bg-blue-50 dark:bg-blue-950 border-blue-500 dark:border-blue-400 text-blue-700 dark:text-blue-300'
              : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-600'
          }`}
        >
          <input
            type="radio"
            name="scale"
            value="0.5"
            checked={props.value === 0.5}
            onChange={() => props.onChange(0.5)}
            class="sr-only"
          />
          <div class="text-center">
            <div class="font-medium">50%</div>
            <Show when={getOutputResolution(0.5)}>
              <div class="text-xs mt-1 opacity-75">{getOutputResolution(0.5)}</div>
            </Show>
          </div>
        </label>

        <label
          class={`relative flex items-center justify-center px-4 py-3 border rounded-lg cursor-pointer transition-colors ${
            props.value === 0.75
              ? 'bg-blue-50 dark:bg-blue-950 border-blue-500 dark:border-blue-400 text-blue-700 dark:text-blue-300'
              : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-600'
          }`}
        >
          <input
            type="radio"
            name="scale"
            value="0.75"
            checked={props.value === 0.75}
            onChange={() => props.onChange(0.75)}
            class="sr-only"
          />
          <div class="text-center">
            <div class="font-medium">75%</div>
            <Show when={getOutputResolution(0.75)}>
              <div class="text-xs mt-1 opacity-75">{getOutputResolution(0.75)}</div>
            </Show>
          </div>
        </label>

        <label
          class={`relative flex items-center justify-center px-4 py-3 border rounded-lg cursor-pointer transition-colors ${
            props.value === 1.0
              ? 'bg-blue-50 dark:bg-blue-950 border-blue-500 dark:border-blue-400 text-blue-700 dark:text-blue-300'
              : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-600'
          }`}
        >
          <input
            type="radio"
            name="scale"
            value="1.0"
            checked={props.value === 1.0}
            onChange={() => props.onChange(1.0)}
            class="sr-only"
          />
          <div class="text-center">
            <div class="font-medium">100%</div>
            <Show when={getOutputResolution(1.0)}>
              <div class="text-xs mt-1 opacity-75">{getOutputResolution(1.0)}</div>
            </Show>
          </div>
        </label>
      </div>
    </div>
  );
};

export default ScaleSelector;
