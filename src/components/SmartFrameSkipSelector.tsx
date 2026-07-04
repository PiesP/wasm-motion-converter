// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { SmartFrameSkipMode } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { createMemo, splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

interface SmartFrameSkipSelectorProps {
  value: SmartFrameSkipMode;
  onChange: (mode: SmartFrameSkipMode) => void;
  disabled?: boolean | undefined;
}

const SmartFrameSkipSelector: Component<SmartFrameSkipSelectorProps> = (props) => {
  const { t } = useLocale();
  const [local] = splitProps(props, ['value', 'onChange', 'disabled']);

  const SKIP_OPTIONS = createMemo<OptionSelectorOption<SmartFrameSkipMode>[]>(() => [
    { value: 'off', label: t('frameSkip.off'), description: t('frameSkip.offDesc') },
    { value: 'low', label: t('frameSkip.low'), description: t('frameSkip.lowDesc') },
    { value: 'medium', label: t('frameSkip.medium'), description: t('frameSkip.mediumDesc') },
    { value: 'high', label: t('frameSkip.high'), description: t('frameSkip.highDesc') },
    { value: 'adaptive', label: t('frameSkip.adaptive'), description: t('frameSkip.adaptiveDesc') },
  ]);

  return (
    <OptionSelector
      title={t('frameSkip.title')}
      name="smart-frame-skip"
      value={local.value}
      options={SKIP_OPTIONS()}
      onChange={local.onChange}
      disabled={local.disabled}
      columns={2}
      tooltip={t('frameSkip.tooltip')}
    />
  );
};

export default SmartFrameSkipSelector;
