// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import type { VideoMetadata } from '@t/conversion-types';
import { formatBytes, formatDuration } from '@utils/format-utils';
import type { Component } from 'solid-js';
import { createMemo, splitProps } from 'solid-js';

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
    <div
      class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6"
      data-testid="video-metadata"
    >
      <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Input Video</h3>
      <dl class="space-y-2">
        <div class="grid grid-cols-[auto_1fr] gap-x-4 items-baseline">
          <dt class="text-gray-500 dark:text-gray-400 text-xs">File</dt>
          <dd class="text-gray-900 dark:text-white truncate text-sm">{local.fileName}</dd>
        </div>
        <div class="grid grid-cols-[auto_1fr] gap-x-4 items-baseline">
          <dt class="text-gray-500 dark:text-gray-400 text-xs">Resolution</dt>
          <dd class="text-gray-900 dark:text-white text-sm">
            {local.metadata.width}x{local.metadata.height}
          </dd>
        </div>
        <div class="grid grid-cols-[auto_1fr] gap-x-4 items-baseline">
          <dt class="text-gray-500 dark:text-gray-400 text-xs">Duration</dt>
          <dd class="text-gray-900 dark:text-white text-sm">
            {formatDuration(local.metadata.duration)}
          </dd>
        </div>
        <div class="grid grid-cols-[auto_1fr] gap-x-4 items-baseline">
          <dt class="text-gray-500 dark:text-gray-400 text-xs">Codec</dt>
          <dd class="text-gray-900 dark:text-white text-sm uppercase">{codecDisplay()}</dd>
        </div>
        <div class="grid grid-cols-[auto_1fr] gap-x-4 items-baseline">
          <dt class="text-gray-500 dark:text-gray-400 text-xs">File Size</dt>
          <dd class="text-gray-900 dark:text-white text-sm">{formatBytes(local.fileSize)}</dd>
        </div>
      </dl>
    </div>
  );
};

export default VideoMetadataDisplay;
