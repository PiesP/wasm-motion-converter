import type { Component } from 'solid-js';
import type { ConversionScale, VideoMetadata } from '../types/conversion-types';
import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

interface ScaleSelectorProps {
  value: ConversionScale;
  onChange: (scale: ConversionScale) => void;
  inputMetadata: VideoMetadata | null;
  disabled?: boolean;
}

const ScaleSelector: Component<ScaleSelectorProps> = (props) => {
  const getOutputResolution = (scale: ConversionScale) => {
    if (!props.inputMetadata) {
      return undefined;
    }
    const width = Math.round(props.inputMetadata.width * scale);
    const height = Math.round(props.inputMetadata.height * scale);
    return `${width}x${height}`;
  };

  const options = (): OptionSelectorOption<ConversionScale>[] => [
    { value: 0.5, label: '50%', description: getOutputResolution(0.5) },
    { value: 0.75, label: '75%', description: getOutputResolution(0.75) },
    { value: 1.0, label: '100%', description: getOutputResolution(1.0) },
  ];

  return (
    <OptionSelector
      title="Output Scale"
      name="scale"
      value={props.value}
      options={options()}
      onChange={props.onChange}
      disabled={props.disabled}
      columns={3}
    />
  );
};

export default ScaleSelector;
