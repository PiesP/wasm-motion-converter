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
      class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4"
      data-testid="video-metadata"
    >
      <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Input Video</h3>
      <dl class="space-y-2 text-sm">
        <div class="flex justify-between">
          <dt class="text-gray-600 dark:text-gray-400">File:</dt>
          <dd class="font-medium text-gray-900 dark:text-white truncate ml-2">{local.fileName}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-gray-600 dark:text-gray-400">Resolution:</dt>
          <dd class="font-medium text-gray-900 dark:text-white">
            {local.metadata.width}x{local.metadata.height}
          </dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-gray-600 dark:text-gray-400">Duration:</dt>
          <dd class="font-medium text-gray-900 dark:text-white">
            {formatDuration(local.metadata.duration)}
          </dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-gray-600 dark:text-gray-400">Codec:</dt>
          <dd class="font-medium text-gray-900 dark:text-white uppercase">{codecDisplay()}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-gray-600 dark:text-gray-400">File Size:</dt>
          <dd class="font-medium text-gray-900 dark:text-white">{formatBytes(local.fileSize)}</dd>
        </div>
      </dl>
    </div>
  );
};

export default VideoMetadataDisplay;
