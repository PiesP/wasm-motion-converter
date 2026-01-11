import { splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

import type { Component } from 'solid-js';
import type { ConversionScale, VideoMetadata } from '@t/conversion-types';

/**
 * Default number of columns for scale selector grid
 */
const DEFAULT_COLUMNS = 3;

/**
 * Available scale percentage options
 */
const SCALE_50_PERCENT = 0.5;
const SCALE_75_PERCENT = 0.75;
const SCALE_100_PERCENT = 1.0;

/**
 * Scale selector component props
 */
interface ScaleSelectorProps {
  /** Currently selected scale value */
  value: ConversionScale;
  /** Callback when scale is changed */
  onChange: (scale: ConversionScale) => void;
  /** Input video metadata for resolution calculation */
  inputMetadata: VideoMetadata | null;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** Optional tooltip text */
  tooltip?: string;
}

/**
 * Scale selector component for output resolution
 *
 * Provides a user-friendly interface for selecting output scale (50%, 75%, 100%).
 * Displays calculated output resolution based on input video metadata.
 * Uses OptionSelector internally with dynamic resolution descriptions.
 *
 * @example
 * ```tsx
 * <ScaleSelector
 *   value={1.0}
 *   onChange={(scale) => setScale(scale)}
 *   inputMetadata={{ width: 1920, height: 1080 }}
 *   tooltip="Choose output resolution scale"
 * />
 * ```
 */
const ScaleSelector: Component<ScaleSelectorProps> = (props) => {
  const [local] = splitProps(props, ['value', 'onChange', 'disabled', 'tooltip', 'inputMetadata']);
  const getOutputResolution = (scale: ConversionScale): string | undefined => {
    if (!local.inputMetadata) {
      return undefined;
    }
    const width = Math.round(local.inputMetadata.width * scale);
    const height = Math.round(local.inputMetadata.height * scale);
    return `${width}x${height}`;
  };

  const options = (): OptionSelectorOption<ConversionScale>[] => [
    { value: SCALE_50_PERCENT, label: '50%', description: getOutputResolution(SCALE_50_PERCENT) },
    { value: SCALE_75_PERCENT, label: '75%', description: getOutputResolution(SCALE_75_PERCENT) },
    {
      value: SCALE_100_PERCENT,
      label: '100%',
      description: getOutputResolution(SCALE_100_PERCENT),
    },
  ];

  return (
    <OptionSelector
      title="Output Scale"
      name="scale"
      value={local.value}
      options={options()}
      onChange={local.onChange}
      disabled={local.disabled}
      columns={DEFAULT_COLUMNS}
      tooltip={local.tooltip}
    />
  );
};

export default ScaleSelector;
