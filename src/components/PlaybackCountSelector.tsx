// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { useLocale } from '@hooks/use-locale';
import { DEFAULT_CUSTOM_PLAY_COUNT, MAX_PLAY_COUNT, parseCustomPlayCount } from '@utils/playback-count';
import type { Component } from 'solid-js';
import { createEffect, createMemo, createSignal, Show } from 'solid-js';

import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

type PlaybackMode = 'forever' | 'once' | 'custom';

interface PlaybackCountSelectorProps {
  value: number;
  onChange: (count: number) => void;
  onValidityChange: (valid: boolean) => void;
  disabled: boolean;
}

const PlaybackCountSelector: Component<PlaybackCountSelectorProps> = (props) => {
  const { t } = useLocale();
  const committed = createMemo(() => props.value);
  const mode = createMemo<PlaybackMode>(() =>
    committed() === 0 ? 'forever' : committed() === 1 ? 'once' : 'custom'
  );
  const [draft, setDraft] = createSignal(
    String(props.value >= 2 ? props.value : DEFAULT_CUSTOM_PLAY_COUNT)
  );
  const valid = createMemo(() => parseCustomPlayCount(draft()) !== undefined);
  const options = createMemo<OptionSelectorOption<PlaybackMode>[]>(() => [
    { value: 'forever', label: t('playback.forever') },
    { value: 'once', label: t('playback.once') },
    { value: 'custom', label: t('playback.custom') },
  ]);

  createEffect(() => {
    const count = committed();
    if (count >= 2) setDraft(String(count));
    props.onValidityChange(true);
  });

  const selectMode = (selection: PlaybackMode): void => {
    if (selection === 'custom') {
      const count = parseCustomPlayCount(draft()) ?? DEFAULT_CUSTOM_PLAY_COUNT;
      setDraft(String(count));
      props.onChange(count);
    } else {
      props.onChange(selection === 'forever' ? 0 : 1);
    }
    props.onValidityChange(true);
  };

  const updateDraft = (value: string): void => {
    setDraft(value);
    const count = parseCustomPlayCount(value);
    props.onValidityChange(count !== undefined);
    if (count !== undefined) props.onChange(count);
  };

  return (
    <div class="[&>fieldset]:mb-2 mb-6">
      <OptionSelector
        title={t('playback.title')}
        name="playback-count"
        value={mode()}
        options={options()}
        onChange={selectMode}
        disabled={props.disabled}
        tooltip={t('playback.tooltip')}
      />
      <Show when={mode() === 'custom'}>
        <label class="block text-xs text-text-secondary" for="custom-playback-count">
          {t('playback.customLabel')}
        </label>
        <input
          id="custom-playback-count"
          data-testid="custom-playback-count"
          type="number"
          inputmode="numeric"
          min={2}
          max={MAX_PLAY_COUNT}
          step={1}
          value={draft()}
          disabled={props.disabled}
          aria-invalid={!valid()}
          aria-describedby="playback-count-hint"
          class="mt-1 min-h-target-minimum w-full rounded-button border border-border-standard bg-bg-panel px-3 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onInput={(event) => updateDraft(event.currentTarget.value)}
        />
        <p id="playback-count-hint" class="mt-1 text-xs text-text-secondary" aria-live="polite">
          {valid() ? t('playback.tooltip') : t('playback.invalid')}
        </p>
      </Show>
    </div>
  );
};

export default PlaybackCountSelector;
