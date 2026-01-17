import type { ConversionScale, VideoMetadata } from '@t/conversion-types';
import { type Component, createMemo, splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

const SCALE_COLUMNS = 3;
const SCALE_50_PERCENT = 0.5;
const SCALE_75_PERCENT = 0.75;
const SCALE_100_PERCENT = 1.0;

interface ScaleSelectorProps {
  value: ConversionScale;
  onChange: (scale: ConversionScale) => void;
  inputMetadata: VideoMetadata | null;
  disabled?: boolean;
  tooltip?: string;
}

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

  const options = createMemo<OptionSelectorOption<ConversionScale>[]>(() => [
    { value: SCALE_50_PERCENT, label: '50%', description: getOutputResolution(SCALE_50_PERCENT) },
    { value: SCALE_75_PERCENT, label: '75%', description: getOutputResolution(SCALE_75_PERCENT) },
    {
      value: SCALE_100_PERCENT,
      label: '100%',
      description: getOutputResolution(SCALE_100_PERCENT),
    },
  ]);

  return (
    <OptionSelector
      title="Output Scale"
      name="scale"
      value={local.value}
      options={options()}
      onChange={local.onChange}
      disabled={local.disabled}
      columns={SCALE_COLUMNS}
      tooltip={local.tooltip}
    />
  );
};

export default ScaleSelector;
