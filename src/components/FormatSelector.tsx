// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { isAvifAnimationSupported } from '@services/encoders/avif-encoder';
import type { ConversionFormat } from '@t/conversion-types';
import { type Component, createResource, splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

const BASE_OPTIONS: OptionSelectorOption<ConversionFormat>[] = [
  { value: 'gif', label: 'GIF', description: 'Universal support' },
  { value: 'webp', label: 'WebP', description: 'Smaller file size' },
];

const AVIF_OPTION: OptionSelectorOption<ConversionFormat> = {
  value: 'avif',
  label: 'AVIF',
  description: 'Experimental — smaller files, slower encoding',
};

const FORMAT_COLUMNS = 2;

interface FormatSelectorProps {
  value: ConversionFormat;
  onChange: (format: ConversionFormat) => void;
  disabled?: boolean;
  tooltip?: string;
}

const FormatSelector: Component<FormatSelectorProps> = (props) => {
  const [local] = splitProps(props, ['value', 'onChange', 'disabled', 'tooltip']);
  const [avifSupported] = createResource(isAvifAnimationSupported);

  const formatOptions = () => {
    if (avifSupported()) {
      return [...BASE_OPTIONS, AVIF_OPTION];
    }
    return BASE_OPTIONS;
  };

  return (
    <OptionSelector
      title="Output Format"
      name="format"
      value={local.value}
      options={formatOptions()}
      onChange={local.onChange}
      disabled={local.disabled}
      columns={FORMAT_COLUMNS}
      tooltip={local.tooltip}
    />
  );
};

export default FormatSelector;
