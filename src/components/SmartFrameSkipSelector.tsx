// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { SmartFrameSkipMode } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { splitProps } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

const SKIP_OPTIONS: OptionSelectorOption<SmartFrameSkipMode>[] = [
  { value: 'off', label: 'Off', description: 'Fixed FPS decimation' },
  { value: 'low', label: 'Low', description: 'Skip near-identical frames' },
  { value: 'medium', label: 'Medium', description: 'Skip noise-level changes' },
  { value: 'high', label: 'High', description: 'Skip slow changes too' },
];

interface SmartFrameSkipSelectorProps {
  value: SmartFrameSkipMode;
  onChange: (mode: SmartFrameSkipMode) => void;
  disabled?: boolean;
}

const SmartFrameSkipSelector: Component<SmartFrameSkipSelectorProps> = (props) => {
  const [local] = splitProps(props, ['value', 'onChange', 'disabled']);

  return (
    <OptionSelector
      title="Smart Frame Skip"
      name="smart-frame-skip"
      value={local.value}
      options={SKIP_OPTIONS}
      onChange={local.onChange}
      disabled={local.disabled}
      columns={2}
      tooltip="Skip similar frames to reduce file size. Motion is preserved."
    />
  );
};

export default SmartFrameSkipSelector;
