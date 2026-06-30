// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import FormatSelector from '@components/FormatSelector';
import QualitySelector from '@components/QualitySelector';
import ScaleSelector from '@components/ScaleSelector';
import SmartFrameSkipSelector from '@components/SmartFrameSkipSelector';
import TrimSelector from '@components/TrimSelector';
import Button from '@components/ui/Button';
import Panel from '@components/ui/Panel';
import { useLocale } from '@hooks/use-locale';
import type { ConversionSettings, VideoMetadata } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { createMemo, Show, splitProps } from 'solid-js';

interface SettingsPanelProps {
  isBusy: boolean;
  isConverting: boolean;
  isConversionActive: boolean;
  settings: ConversionSettings;
  metadata: VideoMetadata | null;
  onConvert: () => void;
  onCancel: () => void;
  onFormatChange: (format: ConversionSettings['format']) => void;
  onQualityChange: (quality: ConversionSettings['quality']) => void;
  onScaleChange: (scale: ConversionSettings['scale']) => void;
  onTrimChange: (start: number, end: number) => void;
  onSmartFrameSkipChange: (mode: ConversionSettings['smartFrameSkip']) => void;
}

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  const { t } = useLocale();
  const [local] = splitProps(props, [
    'isBusy',
    'isConverting',
    'isConversionActive',
    'settings',
    'metadata',
    'onConvert',
    'onCancel',
    'onFormatChange',
    'onQualityChange',
    'onScaleChange',
    'onTrimChange',
    'onSmartFrameSkipChange',
  ]);

  const ariaLabel = createMemo(() =>
    !local.metadata ? t('settings.selectVideo') : t('settings.convert')
  );

  const convertVariant = createMemo(() => (!local.metadata ? 'ghost' : ('primary' as const)));

  const convertDisabled = createMemo(() => !local.metadata || local.isBusy);

  const convertText = createMemo(() =>
    !local.metadata ? t('settings.selectVideo') : t('settings.convert')
  );

  return (
    <Panel class="p-4">
      <Show when={local.metadata}>
        <div class="mb-4">
          <TrimSelector
            duration={local.metadata!.duration}
            trimStart={local.settings.trimStart}
            trimEnd={local.settings.trimEnd}
            disabled={local.isConversionActive}
            onChange={local.onTrimChange}
          />
        </div>
      </Show>

      <FormatSelector
        disabled={local.isConversionActive}
        onChange={local.onFormatChange}
        tooltip={t('settings.tooltip.format')}
        value={local.settings.format}
      />

      <QualitySelector
        disabled={local.isConversionActive}
        onChange={local.onQualityChange}
        tooltip={t('settings.tooltip.quality')}
        value={local.settings.quality}
      />

      <SmartFrameSkipSelector
        disabled={local.isConversionActive}
        onChange={local.onSmartFrameSkipChange}
        value={local.settings.smartFrameSkip}
      />

      <ScaleSelector
        disabled={local.isConversionActive}
        inputMetadata={local.metadata}
        onChange={local.onScaleChange}
        tooltip={t('settings.tooltip.scale')}
        value={local.settings.scale}
      />

      <div class="mt-4">
        <div class="flex gap-2">
          <Show
            when={local.isConverting}
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
              ariaLabel={t('settings.stopConversion')}
              class="flex-1"
              onClick={local.onCancel}
              variant="danger"
              data-testid="stop-conversion-button"
            >
              {t('settings.stopConversion')}
            </Button>
          </Show>
        </div>
      </div>
    </Panel>
  );
};

export default SettingsPanel;
