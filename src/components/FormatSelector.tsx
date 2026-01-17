import type { ConversionFormat } from '@t/conversion-types';
import { type Component, splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

const FORMAT_OPTIONS: OptionSelectorOption<ConversionFormat>[] = [
  { value: 'gif', label: 'GIF', description: 'Universal support' },
  { value: 'webp', label: 'WebP', description: 'Smaller file size' },
];

const FORMAT_COLUMNS = 2;

interface FormatSelectorProps {
  value: ConversionFormat;
  onChange: (format: ConversionFormat) => void;
  disabled?: boolean;
  tooltip?: string;
}

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
      columns={FORMAT_COLUMNS}
      tooltip={local.tooltip}
    />
  );
};

export default FormatSelector;
