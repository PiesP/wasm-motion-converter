import type { VideoMetadata } from '@t/conversion-types';
import { formatBytes } from '@utils/format-bytes';
import { formatDuration } from '@utils/format-duration';
import { type Component, createMemo, splitProps } from 'solid-js';

const UNKNOWN_CODEC = 'unknown';
const DETECTING_LABEL = 'Detecting...';

interface VideoMetadataDisplayProps {
  metadata: VideoMetadata;
  fileName: string;
  fileSize: number;
}

const VideoMetadataDisplay: Component<VideoMetadataDisplayProps> = (props) => {
  const [local] = splitProps(props, ['metadata', 'fileName', 'fileSize']);

  const codecDisplay = createMemo(() =>
    local.metadata.codec === UNKNOWN_CODEC ? DETECTING_LABEL : local.metadata.codec
  );

  return (
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
      <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Input Video</h3>
      <div class="space-y-2 text-sm">
        <div class="flex justify-between">
          <span class="text-gray-600 dark:text-gray-400">File:</span>
          <span class="font-medium text-gray-900 dark:text-white truncate ml-2">
            {local.fileName}
          </span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-600 dark:text-gray-400">Resolution:</span>
          <span class="font-medium text-gray-900 dark:text-white">
            {local.metadata.width}x{local.metadata.height}
          </span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-600 dark:text-gray-400">Duration:</span>
          <span class="font-medium text-gray-900 dark:text-white">
            {formatDuration(local.metadata.duration)}
          </span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-600 dark:text-gray-400">Codec:</span>
          <span class="font-medium text-gray-900 dark:text-white uppercase">{codecDisplay()}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-600 dark:text-gray-400">File Size:</span>
          <span class="font-medium text-gray-900 dark:text-white">
            {formatBytes(local.fileSize)}
          </span>
        </div>
      </div>
    </div>
  );
};

export default VideoMetadataDisplay;
