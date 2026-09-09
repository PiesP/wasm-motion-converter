// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import FormatSelector from '@components/FormatSelector';
import QualitySelector from '@components/QualitySelector';
import ScaleSelector from '@components/ScaleSelector';
import SmartFrameSkipSelector from '@components/SmartFrameSkipSelector';
import Button from '@components/ui/Button';
import Panel from '@components/ui/Panel';
import { useLocale } from '@hooks/use-locale';
import type { ConversionSettings, VideoMetadata } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { createMemo, Show, splitProps } from 'solid-js';

interface SettingsPanelProps {
  isBusy: boolean;
  isCancelling: boolean;
  isComplete: boolean;
  isConversionActive: boolean;
  settings: ConversionSettings;
  metadata: VideoMetadata | null;
  onConvert: () => void;
  onCancel: () => void;
  onFormatChange: (format: ConversionSettings['format']) => void;
  onQualityChange: (quality: ConversionSettings['quality']) => void;
  onScaleChange: (scale: ConversionSettings['scale']) => void;
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
    'onCancel',
    'onFormatChange',
    'onQualityChange',
    'onScaleChange',
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

  const convertDisabled = createMemo(() => !local.metadata || local.isBusy);

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
      </div>
    </Panel>
  );
};

export default SettingsPanel;
