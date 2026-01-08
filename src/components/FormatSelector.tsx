import { splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

import type { Component } from 'solid-js';
import type { ConversionFormat } from '../types/conversion-types';

/**
 * Available output format options
 */
const FORMAT_OPTIONS: OptionSelectorOption<ConversionFormat>[] = [
  { value: 'gif', label: 'GIF', description: 'Universal support' },
  { value: 'webp', label: 'WebP', description: 'Smaller file size' },
];

/**
 * Number of columns for format selector grid
 */
const COLUMNS = 2;

/**
 * Format selector component props
 */
interface FormatSelectorProps {
  /** Currently selected format */
  value: ConversionFormat;
  /** Callback when format changes */
  onChange: (format: ConversionFormat) => void;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** Optional tooltip text */
  tooltip?: string;
}

/**
 * Format selector component for choosing output format
 *
 * Allows users to select between GIF and WebP output formats
 * with descriptions of each format's characteristics.
 *
 * @example
 * ```tsx
 * <FormatSelector
 *   value={selectedFormat}
 *   onChange={(format) => setFormat(format)}
 *   disabled={isProcessing}
 * />
 * ```
 */
const FormatSelector: Component<FormatSelectorProps> = (props) => {
  const [local] = splitProps(props, ['value', 'onChange', 'disabled', 'tooltip']);
  return (
    <OptionSelector
      title="Output Format"
      name="format"
      value={local.value}
      options={FORMAT_OPTIONS}
      onChange={local.onChange}
      disabled={local.disabled}
      columns={COLUMNS}
      tooltip={local.tooltip}
    />
  );
};

export default FormatSelector;
