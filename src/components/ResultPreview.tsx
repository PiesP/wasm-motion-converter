import Button from '@components/ui/Button';
import Panel from '@components/ui/Panel';
import type { ConversionSettings } from '@t/conversion-types';
import { formatBytes } from '@utils/format-bytes';
import { formatDuration } from '@utils/format-duration';
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  splitProps,
} from 'solid-js';

const SCALE_PERCENTAGE_MULTIPLIER = 100;
const INITIAL_LOADED_STATE = false;

interface ResultPreviewProps {
  outputBlob: Blob;
  originalName: string;
  originalSize: number;
  settings: ConversionSettings;
  conversionDurationSeconds?: number;
  wasTranscoded?: boolean;
  originalCodec?: string;
}

const ResultPreview: Component<ResultPreviewProps> = (props) => {
  const [local] = splitProps(props, [
    'outputBlob',
    'originalName',
    'originalSize',
    'settings',
    'conversionDurationSeconds',
    'wasTranscoded',
    'originalCodec',
  ]);
  const [loaded, setLoaded] = createSignal(INITIAL_LOADED_STATE);

  const previewUrl = createMemo(() => URL.createObjectURL(local.outputBlob));

  const conversionTimeLabel = createMemo(() => {
    if (typeof local.conversionDurationSeconds !== 'number') {
      return null;
    }
    return formatDuration(local.conversionDurationSeconds);
  });

  const sizeGridClass = createMemo(() =>
    conversionTimeLabel()
      ? 'grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm mt-3'
      : 'grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm mt-3'
  );

  const outputExtension = createMemo(() => {
    if (local.outputBlob.type === 'image/gif') {
      return 'gif';
    }
    if (local.outputBlob.type === 'image/webp') {
      return 'webp';
    }
    return 'webp';
  });

  const downloadFileName = createMemo(() => {
    const originalName = local.originalName.trim();
    const lastDotIndex = originalName.lastIndexOf('.');
    const baseName =
      originalName && lastDotIndex > 0 ? originalName.slice(0, lastDotIndex) : originalName;
    const safeBaseName = baseName.trim() ? baseName : 'converted';

    return `${safeBaseName}.${outputExtension()}`;
  });

  const skeletonClass = createMemo(
    () =>
      `absolute inset-0 transition-opacity duration-300 ${loaded() ? 'opacity-0' : 'opacity-100'}`
  );

  const imageClass = createMemo(
    () =>
      `max-w-full h-auto rounded transition-opacity duration-300 ${loaded() ? 'opacity-100' : 'opacity-0'}`
  );

  createEffect(() => {
    const url = previewUrl();
    setLoaded(INITIAL_LOADED_STATE);
    onCleanup(() => {
      URL.revokeObjectURL(url);
    });
  });

  const handleDownload = () => {
    const url = previewUrl();
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadFileName();
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  const handlePreviewLoad = () => {
    setLoaded(true);
  };

  return (
    <Panel class="p-6">
      <div class="flex gap-3">
        <Button
          ariaLabel="Download converted file"
          class="flex-1"
          onClick={handleDownload}
          data-download-button
        >
          Download
        </Button>
      </div>

      <div class="mt-4 flex justify-center bg-gray-50 dark:bg-gray-950 rounded-lg p-4 relative overflow-hidden">
        <div class={skeletonClass()}>
          <div class="w-full h-full bg-gray-200 dark:bg-gray-800 animate-pulse rounded" />
        </div>
        <img
          src={previewUrl()}
          alt="Converted animation"
          class={imageClass()}
          onLoad={handlePreviewLoad}
          loading="lazy"
        />
      </div>

      <div class="mt-4">
        <h3 class="text-lg font-medium text-gray-900 dark:text-white">Conversion Complete</h3>

        <div class={sizeGridClass()}>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Original Size</div>
            <div class="font-medium text-gray-900 dark:text-white">
              {formatBytes(local.originalSize)}
            </div>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Output Size</div>
            <div class="font-medium text-gray-900 dark:text-white">
              {formatBytes(local.outputBlob.size)}
            </div>
          </div>
          <Show when={conversionTimeLabel()}>
            {(label) => (
              <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
                <div class="text-gray-600 dark:text-gray-400">Conversion Time</div>
                <div class="font-medium text-gray-900 dark:text-white">{label()}</div>
              </div>
            )}
          </Show>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm mt-3">
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Format</div>
            <div class="font-medium text-gray-900 dark:text-white uppercase">
              {local.settings.format}
            </div>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Quality</div>
            <div class="font-medium text-gray-900 dark:text-white capitalize">
              {local.settings.quality}
            </div>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Scale</div>
            <div class="font-medium text-gray-900 dark:text-white">
              {(local.settings.scale * SCALE_PERCENTAGE_MULTIPLIER).toFixed(0)}%
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
};

export default ResultPreview;
