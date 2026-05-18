import FormatSelector from '@components/FormatSelector';
import QualitySelector from '@components/QualitySelector';
import ScaleSelector from '@components/ScaleSelector';
import Button from '@components/ui/Button';
import Panel from '@components/ui/Panel';
import type { ConversionSettings, VideoMetadata } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { Show } from 'solid-js';

interface SettingsPanelProps {
  isBusy: boolean;
  isConverting: boolean;
  settings: ConversionSettings;
  metadata: VideoMetadata | null;
  onConvert: () => void;
  onCancel: () => void;
  onFormatChange: (format: ConversionSettings['format']) => void;
  onQualityChange: (quality: ConversionSettings['quality']) => void;
  onScaleChange: (scale: ConversionSettings['scale']) => void;
}

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  return (
    <Panel class="p-6">
      <div class="mb-6 flex gap-3">
        <Show
          when={props.isConverting}
          fallback={
            <Button
              ariaLabel="Convert video to animated image"
              class="flex-1"
              disabled={!props.metadata || props.isBusy}
              onClick={props.onConvert}
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
          >
            Stop Conversion
          </Button>
        </Show>
      </div>

      <FormatSelector
        disabled={!props.metadata || props.isBusy}
        onChange={props.onFormatChange}
        tooltip="GIF works everywhere, WebP is smaller but requires modern browsers"
        value={props.settings.format}
      />

      <QualitySelector
        disabled={!props.metadata || props.isBusy}
        onChange={props.onQualityChange}
        tooltip="Higher quality = larger file size and slower conversion"
        value={props.settings.quality}
      />

      <ScaleSelector
        disabled={!props.metadata || props.isBusy}
        inputMetadata={props.metadata}
        onChange={props.onScaleChange}
        tooltip="Reduce dimensions to decrease file size and speed up conversion"
        value={props.settings.scale}
      />
    </Panel>
  );
};

export default SettingsPanel;
