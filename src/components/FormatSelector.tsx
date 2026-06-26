// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { ConversionFormat } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

const FORMAT_COLUMNS = 2;

interface FormatSelectorProps {
  value: ConversionFormat;
  onChange: (format: ConversionFormat) => void;
  disabled?: boolean;
  tooltip?: string;
}

const FormatSelector: Component<FormatSelectorProps> = (props) => {
  const { t } = useLocale();
  const [local] = splitProps(props, ['value', 'onChange', 'disabled', 'tooltip']);

  const FORMAT_OPTIONS: OptionSelectorOption<ConversionFormat>[] = [
    { value: 'gif', label: t('format.gif'), description: t('format.gifDesc') },
    { value: 'webp', label: t('format.webp'), description: t('format.webpDesc') },
  ];

  return (
    <OptionSelector
      title={t('format.title')}
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
