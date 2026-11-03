// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import { CONVERSION_SCALES, type ConversionScale, type VideoMetadata } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { createMemo, splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

const SCALE_COLUMNS = 3;
const SCALE_PERCENT = 100;

interface ScaleSelectorProps {
  value: ConversionScale;
  onChange: (scale: ConversionScale) => void;
  inputMetadata: VideoMetadata | null;
  disabled?: boolean | undefined;
  tooltip?: string | undefined;
}

const ScaleSelector: Component<ScaleSelectorProps> = (props) => {
  const { t } = useLocale();
  const [local] = splitProps(props, ['value', 'onChange', 'disabled', 'tooltip', 'inputMetadata']);

  const getOutputResolution = (scale: ConversionScale): string | undefined => {
    if (!local.inputMetadata) {
      return undefined;
    }
    const width = Math.floor(local.inputMetadata.width * scale);
    const height = Math.floor(local.inputMetadata.height * scale);
    return `${width}x${height}`;
  };

  const options = createMemo<OptionSelectorOption<ConversionScale>[]>(() =>
    CONVERSION_SCALES.map((value) => ({
      value,
      label: `${value * SCALE_PERCENT}%`,
      description: getOutputResolution(value),
    }))
  );

  return (
    <OptionSelector
      title={t('scale.title')}
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
