import type { Component } from 'solid-js';
import type { ConversionQuality } from '../types/conversion-types';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

/**
 * Default number of columns for quality selector grid
 */
const DEFAULT_COLUMNS = 3;

/**
 * Available quality preset options
 */
const QUALITY_OPTIONS: OptionSelectorOption<ConversionQuality>[] = [
  { value: 'low', label: 'Low', description: 'Fast' },
  { value: 'medium', label: 'Medium', description: 'Balanced' },
  { value: 'high', label: 'High', description: 'Slow' },
];

/**
 * Quality selector component props
 */
interface QualitySelectorProps {
  /** Currently selected quality preset */
  value: ConversionQuality;
  /** Callback when quality preset is changed */
  onChange: (quality: ConversionQuality) => void;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** Optional tooltip text */
  tooltip?: string;
}

/**
 * Quality preset selector component
 *
 * Provides a user-friendly interface for selecting video conversion quality presets.
 * Uses OptionSelector internally to display Low, Medium, and High quality options
 * with descriptive labels (Fast, Balanced, Slow).
 *
 * @example
 * ```tsx
 * <QualitySelector
 *   value={selectedQuality}
 *   onChange={(quality) => setQuality(quality)}
 *   tooltip="Higher quality produces better results but takes longer"
 * />
 * ```
 */

const QualitySelector: Component<QualitySelectorProps> = (props) => {
  return (
    <OptionSelector
      title="Quality Preset"
      name="quality"
      value={props.value}
      options={QUALITY_OPTIONS}
      onChange={props.onChange}
      disabled={props.disabled}
      columns={DEFAULT_COLUMNS}
      tooltip={props.tooltip}
    />
  );
};

export default QualitySelector;
