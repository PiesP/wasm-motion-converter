import type { Component } from 'solid-js';
import type { ConversionFormat } from '../types/conversion-types';
import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

interface FormatSelectorProps {
  value: ConversionFormat;
  onChange: (format: ConversionFormat) => void;
  disabled?: boolean;
  tooltip?: string;
}

const FormatSelector: Component<FormatSelectorProps> = (props) => {
  const options = (): OptionSelectorOption<ConversionFormat>[] => {
    return [
      { value: 'gif', label: 'GIF', description: 'Universal support' },
      { value: 'webp', label: 'WebP', description: 'Smaller file size' },
    ];
  };

  const columns = (): 2 => 2;

  return (
    <OptionSelector
      title="Output Format"
      name="format"
      value={props.value}
      options={options()}
      onChange={props.onChange}
      disabled={props.disabled}
      columns={columns()}
      tooltip={props.tooltip}
    />
  );
};

export default FormatSelector;
