import type { ConversionQuality } from '@t/conversion-types';
import { type Component, splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

const QUALITY_COLUMNS = 3;

const QUALITY_OPTIONS: OptionSelectorOption<ConversionQuality>[] = [
  { value: 'low', label: 'Low', description: 'Fast' },
  { value: 'medium', label: 'Medium', description: 'Balanced' },
  { value: 'high', label: 'High', description: 'Slow' },
];

interface QualitySelectorProps {
  value: ConversionQuality;
  onChange: (quality: ConversionQuality) => void;
  disabled?: boolean;
  tooltip?: string;
}

const QualitySelector: Component<QualitySelectorProps> = (props) => {
  const [local] = splitProps(props, ['value', 'onChange', 'disabled', 'tooltip']);

  return (
    <OptionSelector
      title="Quality Preset"
      name="quality"
      value={local.value}
      options={QUALITY_OPTIONS}
      onChange={local.onChange}
      disabled={local.disabled}
      columns={QUALITY_COLUMNS}
      tooltip={local.tooltip}
    />
  );
};

export default QualitySelector;
