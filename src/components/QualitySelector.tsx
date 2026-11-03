// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import {
  CONVERSION_QUALITIES,
  type ConversionFormat,
  type ConversionQuality,
} from '@t/conversion-types';
import { GIF_TARGET_FPS, WEBP_TARGET_FPS } from '@utils/constants';
import type { Component } from 'solid-js';
import { createMemo, splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

const QUALITY_COLUMNS = 3;
const QUALITY_LABEL_KEYS = {
  low: ['quality.low', 'quality.lowDesc'],
  medium: ['quality.medium', 'quality.mediumDesc'],
  high: ['quality.high', 'quality.highDesc'],
} as const satisfies Record<ConversionQuality, readonly [string, string]>;

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

  const QUALITY_OPTIONS = createMemo<OptionSelectorOption<ConversionQuality>[]>(() =>
    CONVERSION_QUALITIES.map((value) => ({
      value,
      label: t(QUALITY_LABEL_KEYS[value][0]),
      description: t(QUALITY_LABEL_KEYS[value][1], { fps: targetFps(value) }),
    }))
  );

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
