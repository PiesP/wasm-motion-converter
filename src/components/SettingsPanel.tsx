// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import FormatSelector from '@components/FormatSelector';
import QualitySelector from '@components/QualitySelector';
import ScaleSelector from '@components/ScaleSelector';
import TrimSelector from '@components/TrimSelector';
import Button from '@components/ui/Button';
import Panel from '@components/ui/Panel';
import type { ConversionSettings, VideoMetadata } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { Show, splitProps } from 'solid-js';

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
}

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
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
  ]);
  return (
    <Panel class="p-6">
      <div class="mb-6">
        <div class="flex gap-3">
          <Show
            when={local.isConverting}
            fallback={
              <Button
                ariaLabel="Convert video to animated image"
                class="flex-1"
                disabled={!local.metadata || local.isBusy}
                onClick={local.onConvert}
                data-testid="convert-button"
              >
                Convert
              </Button>
            }
          >
            <Button
              ariaLabel="Stop video conversion"
              class="flex-1"
              onClick={local.onCancel}
              variant="danger"
              data-testid="stop-conversion-button"
            >
              Stop Conversion
            </Button>
          </Show>
        </div>
        {!local.metadata && !local.isBusy && (
          <p class="mt-2 text-xs text-gray-400 dark:text-gray-500 text-center">
            Select a video to start
          </p>
        )}
      </div>

      <Show when={local.metadata}>
        <div class="mb-6">
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
        tooltip="GIF works everywhere, WebP is smaller but requires modern browsers"
        value={local.settings.format}
      />

      <QualitySelector
        disabled={local.isConversionActive}
        onChange={local.onQualityChange}
        tooltip="Higher quality = larger file size and slower conversion"
        value={local.settings.quality}
      />

      <ScaleSelector
        disabled={local.isConversionActive}
        inputMetadata={local.metadata}
        onChange={local.onScaleChange}
        tooltip="Reduce dimensions to decrease file size and speed up conversion"
        value={local.settings.scale}
      />
    </Panel>
  );
};

export default SettingsPanel;
