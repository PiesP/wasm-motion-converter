// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import { SMART_FRAME_SKIP_MODES, type SmartFrameSkipMode } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { createMemo, splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

const SKIP_LABEL_KEYS = {
  off: ['frameSkip.off', 'frameSkip.offDesc'],
  low: ['frameSkip.low', 'frameSkip.lowDesc'],
  medium: ['frameSkip.medium', 'frameSkip.mediumDesc'],
  high: ['frameSkip.high', 'frameSkip.highDesc'],
  adaptive: ['frameSkip.adaptive', 'frameSkip.adaptiveDesc'],
} as const satisfies Record<SmartFrameSkipMode, readonly [string, string]>;

interface SmartFrameSkipSelectorProps {
  value: SmartFrameSkipMode;
  onChange: (mode: SmartFrameSkipMode) => void;
  disabled?: boolean | undefined;
}

const SmartFrameSkipSelector: Component<SmartFrameSkipSelectorProps> = (props) => {
  const { t } = useLocale();
  const [local] = splitProps(props, ['value', 'onChange', 'disabled']);

  const SKIP_OPTIONS = createMemo<OptionSelectorOption<SmartFrameSkipMode>[]>(() =>
    SMART_FRAME_SKIP_MODES.map((value) => ({
      value,
      label: t(SKIP_LABEL_KEYS[value][0]),
      description: t(SKIP_LABEL_KEYS[value][1]),
    }))
  );

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
