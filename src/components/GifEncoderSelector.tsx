import { splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

import type { Component } from 'solid-js';
import type { GifEncoderPreference } from '@t/conversion-types';

/**
 * Available GIF encoder preference options.
 */
const GIF_ENCODER_OPTIONS: OptionSelectorOption<GifEncoderPreference>[] = [
  { value: 'auto', label: 'Auto', description: 'Default strategy selection' },
  {
    value: 'ffmpeg-palette',
    label: 'FFmpeg Palette',
    description: 'palettegen/paletteuse (higher quality, slower)',
  },
];

/**
 * Number of columns for GIF encoder selector grid.
 */
const COLUMNS = 2;

interface GifEncoderSelectorProps {
  /** Currently selected GIF encoder preference. */
  value: GifEncoderPreference;
  /** Callback when the preference changes. */
  onChange: (value: GifEncoderPreference) => void;
  /** Whether the selector is disabled. */
  disabled?: boolean;
  /** Optional tooltip text. */
  tooltip?: string;
}

/**
 * GIF encoder selector component.
 *
 * This is an experimental control to force FFmpeg palettegen/paletteuse for GIF output
 * so users can A/B test quality and performance against the default GPU path.
 */
const GifEncoderSelector: Component<GifEncoderSelectorProps> = (props) => {
  const [local] = splitProps(props, ['value', 'onChange', 'disabled', 'tooltip']);

  return (
    <OptionSelector
      title="GIF Encoder"
      name="gif-encoder"
      value={local.value}
      options={GIF_ENCODER_OPTIONS}
      onChange={local.onChange}
      disabled={local.disabled}
      columns={COLUMNS}
      tooltip={local.tooltip}
    />
  );
};

export default GifEncoderSelector;
