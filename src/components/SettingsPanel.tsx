// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import FormatSelector from '@components/FormatSelector';
import PlaybackCountSelector from '@components/PlaybackCountSelector';
import QualitySelector from '@components/QualitySelector';
import ScaleSelector from '@components/ScaleSelector';
import SmartFrameSkipSelector from '@components/SmartFrameSkipSelector';
import Button from '@components/ui/Button';
import Panel from '@components/ui/Panel';
import { useLocale } from '@hooks/use-locale';
import type { ConversionSettings, VideoMetadata } from '@t/conversion-types';
import { DEFAULT_PLAY_COUNT } from '@utils/playback-count';
import type { Component } from 'solid-js';
import { createMemo, createSignal, Show, splitProps } from 'solid-js';

interface SettingsPanelProps {
  isBusy: boolean;
  isCancelling: boolean;
  isComplete: boolean;
  isConversionActive: boolean;
  settings: ConversionSettings;
  metadata: VideoMetadata | null;
  onConvert: () => void;
  onConvertGifParts?: (() => void) | undefined;
  storeGifPartsInBrowser?: boolean;
  continuousGif?: boolean;
  gifPartsStatus?: string | undefined;
  onCancel: () => void;
  onFormatChange: (format: ConversionSettings['format']) => void;
  onQualityChange: (quality: ConversionSettings['quality']) => void;
  onScaleChange: (scale: ConversionSettings['scale']) => void;
  onPlayCountChange: (count: number) => void;
  onPlayCountValidityChange?: ((valid: boolean) => void) | undefined;
  onSharingSettings: () => void;
  onSmartFrameSkipChange: (mode: ConversionSettings['smartFrameSkip']) => void;
}

const FRAME_SKIP_LABEL_KEYS = {
  off: 'frameSkip.off',
  low: 'frameSkip.low',
  medium: 'frameSkip.medium',
  high: 'frameSkip.high',
  adaptive: 'frameSkip.adaptive',
} as const;

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  const { t } = useLocale();
  const [local] = splitProps(props, [
    'isBusy',
    'isCancelling',
    'isComplete',
    'isConversionActive',
    'settings',
    'metadata',
    'onConvert',
    'onConvertGifParts',
    'storeGifPartsInBrowser',
    'continuousGif',
    'gifPartsStatus',
    'onCancel',
    'onFormatChange',
    'onQualityChange',
    'onScaleChange',
    'onPlayCountChange',
    'onPlayCountValidityChange',
    'onSharingSettings',
    'onSmartFrameSkipChange',
  ]);

  const ariaLabel = createMemo(() =>
    !local.metadata
      ? t('settings.selectVideo')
      : local.isComplete
        ? t('settings.convertAgain')
        : t('settings.convert')
  );

  const convertVariant = createMemo(() =>
    !local.metadata || local.isComplete ? 'ghost' : ('primary' as const)
  );

  const [playCountValid, setPlayCountValid] = createSignal(true);
  const convertDisabled = createMemo(() => !local.metadata || local.isBusy || !playCountValid());

  const convertText = createMemo(() =>
    !local.metadata
      ? t('settings.selectVideo')
      : local.isComplete
        ? t('settings.convertAgain')
        : t('settings.convert')
  );

  const frameSkipSelection = createMemo(() => {
    return t(FRAME_SKIP_LABEL_KEYS[local.settings.smartFrameSkip]);
  });

  const sharingSettingsApplied = createMemo(
    () => local.settings.quality === 'low' && local.settings.scale === 0.5
  );

  return (
    <Panel class="p-4">
      <h2 class="mb-4 text-lg font-semibold text-text-primary">{t('settings.heading')}</h2>
      <h3 class="text-xs font-medium text-text-tertiary mb-2 tracking-wide">
        {t('settings.section.outputSettings')}
      </h3>
      <FormatSelector
        disabled={local.isConversionActive}
        onChange={local.onFormatChange}
        tooltip={t('settings.tooltip.format')}
        value={local.settings.format}
      />

      <QualitySelector
        disabled={local.isConversionActive}
        format={local.settings.format}
        onChange={local.onQualityChange}
        tooltip={t('settings.tooltip.quality')}
        value={local.settings.quality}
      />

      <ScaleSelector
        disabled={local.isConversionActive}
        inputMetadata={local.metadata}
        onChange={local.onScaleChange}
        tooltip={t('settings.tooltip.scale')}
        value={local.settings.scale}
      />

      <PlaybackCountSelector
        value={local.settings.playCount ?? DEFAULT_PLAY_COUNT}
        onChange={local.onPlayCountChange}
        onValidityChange={(valid) => {
          setPlayCountValid(valid);
          local.onPlayCountValidityChange?.(valid);
        }}
        disabled={local.isConversionActive}
      />

      <details class="mb-6 border-t border-border-subtle pt-3" data-testid="advanced-settings">
        <summary class="min-h-target-minimum cursor-pointer content-center text-xs font-medium tracking-wide text-text-secondary">
          <span>{t('settings.section.performance')}</span>
          <span class="ms-2 font-normal text-text-tertiary">· {frameSkipSelection()}</span>
        </summary>
        <div class="mt-4 [&>fieldset]:mb-0">
          <SmartFrameSkipSelector
            disabled={local.isConversionActive}
            onChange={local.onSmartFrameSkipChange}
            value={local.settings.smartFrameSkip}
          />
        </div>
      </details>

      <div class="mt-4">
        <div class="flex gap-2">
          <Show
            when={local.isConversionActive}
            fallback={
              <Button
                ariaLabel={ariaLabel()}
                class="flex-1"
                disabled={convertDisabled()}
                onClick={local.onConvert}
                variant={convertVariant()}
                data-testid="convert-button"
              >
                {convertText()}
              </Button>
            }
          >
            <Button
              ariaLabel={
                local.isCancelling ? t('progress.cancelling') : t('settings.stopConversion')
              }
              class="flex-1"
              disabled={local.isCancelling}
              onClick={local.onCancel}
              variant="ghost"
              data-testid="stop-conversion-button"
            >
              {local.isCancelling ? t('progress.cancelling') : t('settings.stopConversion')}
            </Button>
          </Show>
        </div>
        <Show
          when={
            !local.isConversionActive && local.settings.format === 'gif' && local.onConvertGifParts
          }
        >
          {(saveParts) => (
            <Button
              class="mt-2 w-full"
              disabled={convertDisabled()}
              onClick={saveParts()}
              variant="ghost"
              data-testid="convert-gif-parts-button"
            >
              {t(
                local.continuousGif
                  ? 'settings.storeContinuousGif'
                  : local.storeGifPartsInBrowser
                    ? 'settings.storeGifParts'
                    : 'settings.saveGifParts'
              )}
            </Button>
          )}
        </Show>
        <p
          role="status"
          class="text-xs text-text-secondary"
          classList={{ 'mt-2': Boolean(local.gifPartsStatus) }}
          data-testid="gif-parts-status"
        >
          {local.gifPartsStatus}
        </p>
      </div>

      <details class="mt-3 border-t border-border-subtle pt-2" data-testid="sharing-settings">
        <summary class="min-h-target-minimum cursor-pointer content-center text-xs font-medium text-text-secondary">
          {t('settings.sharing.title')}
        </summary>
        <div class="space-y-2 pt-2">
          <p class="text-xs leading-relaxed text-text-secondary">
            {t('settings.sharing.description')}
          </p>
          <p class="text-xs leading-relaxed text-text-secondary">
            {t('settings.sharing.sizeHint')}
          </p>
          <Button
            class="w-full"
            disabled={local.isBusy || sharingSettingsApplied()}
            onClick={local.onSharingSettings}
            variant="ghost"
            data-testid="sharing-settings-button"
          >
            {sharingSettingsApplied() ? t('settings.sharing.applied') : t('settings.sharing.apply')}
          </Button>
        </div>
      </details>
    </Panel>
  );
};

export default SettingsPanel;
