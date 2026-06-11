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
import { Show } from 'solid-js';

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
  return (
    <Panel class="p-6">
      <div class="mb-6">
        <div class="flex gap-3">
          <Show
            when={props.isConverting}
            fallback={
              <Button
                ariaLabel="Convert video to animated image"
                class="flex-1"
                disabled={!props.metadata || props.isBusy}
                onClick={props.onConvert}
                data-testid="convert-button"
              >
                Convert
              </Button>
            }
          >
            <Button
              ariaLabel="Stop video conversion"
              class="flex-1"
              onClick={props.onCancel}
              variant="danger"
              data-testid="stop-conversion-button"
            >
              Stop Conversion
            </Button>
          </Show>
        </div>
        {!props.metadata && !props.isBusy && (
          <p class="mt-2 text-xs text-gray-400 dark:text-gray-500 text-center">
            Select a video to start
          </p>
        )}
      </div>

      <Show when={props.metadata}>
        <div class="mb-6">
          <TrimSelector
            duration={props.metadata!.duration}
            trimStart={props.settings.trimStart}
            trimEnd={props.settings.trimEnd}
            disabled={props.isConversionActive}
            onChange={props.onTrimChange}
          />
        </div>
      </Show>

      <FormatSelector
        disabled={props.isConversionActive}
        onChange={props.onFormatChange}
        tooltip="GIF works everywhere, WebP is smaller but requires modern browsers"
        value={props.settings.format}
      />

      <QualitySelector
        disabled={props.isConversionActive}
        onChange={props.onQualityChange}
        tooltip="Higher quality = larger file size and slower conversion"
        value={props.settings.quality}
      />

      <ScaleSelector
        disabled={props.isConversionActive}
        inputMetadata={props.metadata}
        onChange={props.onScaleChange}
        tooltip="Reduce dimensions to decrease file size and speed up conversion"
        value={props.settings.scale}
      />
    </Panel>
  );
};

export default SettingsPanel;
