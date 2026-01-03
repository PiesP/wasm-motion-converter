import type { Component } from 'solid-js';
import type { ConversionFormat } from '../types/conversion-types';
import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

interface FormatSelectorProps {
  value: ConversionFormat;
  onChange: (format: ConversionFormat) => void;
  disabled?: boolean;
}

const options: OptionSelectorOption<ConversionFormat>[] = [
  { value: 'gif', label: 'GIF', description: 'Universal support' },
  { value: 'webp', label: 'WebP', description: 'Smaller file size' },
];

const FormatSelector: Component<FormatSelectorProps> = (props) => {
  return (
    <OptionSelector
      title="Output Format"
      name="format"
      value={props.value}
      options={options}
      onChange={props.onChange}
      disabled={props.disabled}
      columns={2}
    />
  );
};

export default FormatSelector;
