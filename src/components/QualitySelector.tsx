import type { Component } from 'solid-js';
import type { ConversionQuality } from '../types/conversion-types';
import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

interface QualitySelectorProps {
  value: ConversionQuality;
  onChange: (quality: ConversionQuality) => void;
  disabled?: boolean;
}

const options: OptionSelectorOption<ConversionQuality>[] = [
  { value: 'low', label: 'Low', description: 'Fast, larger' },
  { value: 'medium', label: 'Medium', description: 'Balanced' },
  { value: 'high', label: 'High', description: 'Slow, smaller' },
];

const QualitySelector: Component<QualitySelectorProps> = (props) => {
  return (
    <OptionSelector
      title="Quality Preset"
      name="quality"
      value={props.value}
      options={options}
      onChange={props.onChange}
      disabled={props.disabled}
      columns={3}
    />
  );
};

export default QualitySelector;
