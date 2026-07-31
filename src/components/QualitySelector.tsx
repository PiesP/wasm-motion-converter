// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { ConversionFormat, ConversionQuality } from '@t/conversion-types';
import { GIF_TARGET_FPS, WEBP_TARGET_FPS } from '@utils/constants';
import type { Component } from 'solid-js';
import { createMemo, splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

const QUALITY_COLUMNS = 3;

interface QualitySelectorProps {
  format: ConversionFormat;
  value: ConversionQuality;
  onChange: (quality: ConversionQuality) => void;
  disabled?: boolean | undefined;
  tooltip?: string | undefined;
}

const QualitySelector: Component<QualitySelectorProps> = (props) => {
  const { t } = useLocale();
  const [local] = splitProps(props, ['format', 'value', 'onChange', 'disabled', 'tooltip']);

  const targetFps = (quality: ConversionQuality): number =>
    local.format === 'gif' ? GIF_TARGET_FPS[quality] : WEBP_TARGET_FPS[quality];

  const QUALITY_OPTIONS = createMemo<OptionSelectorOption<ConversionQuality>[]>(() => [
    {
      value: 'low',
      label: t('quality.low'),
      description: t('quality.lowDesc', { fps: targetFps('low') }),
    },
    {
      value: 'medium',
      label: t('quality.medium'),
      description: t('quality.mediumDesc', { fps: targetFps('medium') }),
    },
    {
      value: 'high',
      label: t('quality.high'),
      description: t('quality.highDesc', { fps: targetFps('high') }),
    },
  ]);

  return (
    <OptionSelector
      title={t('quality.title')}
      name="quality"
      value={local.value}
      options={QUALITY_OPTIONS()}
      onChange={local.onChange}
      disabled={local.disabled}
      columns={QUALITY_COLUMNS}
      tooltip={local.tooltip}
    />
  );
};

export default QualitySelector;
