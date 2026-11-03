// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import { CONVERSION_FORMATS, type ConversionFormat } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { createMemo, splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

const FORMAT_COLUMNS = 2;
const FORMAT_LABEL_KEYS = {
  gif: ['format.gif', 'format.gifDesc'],
  webp: ['format.webp', 'format.webpDesc'],
} as const satisfies Record<ConversionFormat, readonly [string, string]>;

interface FormatSelectorProps {
  value: ConversionFormat;
  onChange: (format: ConversionFormat) => void;
  disabled?: boolean | undefined;
  tooltip?: string | undefined;
}

const FormatSelector: Component<FormatSelectorProps> = (props) => {
  const { t } = useLocale();
  const [local] = splitProps(props, ['value', 'onChange', 'disabled', 'tooltip']);

  const FORMAT_OPTIONS = createMemo<OptionSelectorOption<ConversionFormat>[]>(() =>
    CONVERSION_FORMATS.map((value) => ({
      value,
      label: t(FORMAT_LABEL_KEYS[value][0]),
      description: t(FORMAT_LABEL_KEYS[value][1]),
    }))
  );

  return (
    <OptionSelector
      title={t('format.title')}
      name="format"
      value={local.value}
      options={FORMAT_OPTIONS()}
      onChange={local.onChange}
      disabled={local.disabled}
      columns={FORMAT_COLUMNS}
      tooltip={local.tooltip}
    />
  );
};

export default FormatSelector;
