// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { ConversionQuality } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

const QUALITY_COLUMNS = 3;

interface QualitySelectorProps {
  value: ConversionQuality;
  onChange: (quality: ConversionQuality) => void;
  disabled?: boolean;
  tooltip?: string;
}

const QualitySelector: Component<QualitySelectorProps> = (props) => {
  const { t } = useLocale();
  const [local] = splitProps(props, ['value', 'onChange', 'disabled', 'tooltip']);

  const QUALITY_OPTIONS: OptionSelectorOption<ConversionQuality>[] = [
    { value: 'low', label: t('quality.low'), description: t('quality.lowDesc') },
    { value: 'medium', label: t('quality.medium'), description: t('quality.mediumDesc') },
    { value: 'high', label: t('quality.high'), description: t('quality.highDesc') },
  ];

  return (
    <OptionSelector
      title={t('quality.title')}
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
