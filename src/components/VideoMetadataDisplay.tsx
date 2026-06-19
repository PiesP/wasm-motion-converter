// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

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
    local.metadata.codec === UNKNOWN_CODEC ? DETECTING_LABEL : local.metadata.codec.toUpperCase()
  );

  return (
    <div
      class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4"
      data-testid="video-metadata"
    >
      <h3 class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">
        Input Video
      </h3>
      <dl class="space-y-1.5 text-sm">
        <div class="flex justify-between gap-3">
          <dt class="text-gray-500 dark:text-gray-400 shrink-0">File</dt>
          <dd class="text-gray-900 dark:text-white truncate text-right">{local.fileName}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-gray-500 dark:text-gray-400 shrink-0">Resolution</dt>
          <dd class="text-gray-900 dark:text-white tabular-nums">
            {local.metadata.width}×{local.metadata.height}
          </dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-gray-500 dark:text-gray-400 shrink-0">Duration</dt>
          <dd class="text-gray-900 dark:text-white tabular-nums">
            {formatDuration(local.metadata.duration)}
          </dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-gray-500 dark:text-gray-400 shrink-0">FPS</dt>
          <dd class="text-gray-900 dark:text-white tabular-nums">{local.metadata.framerate}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-gray-500 dark:text-gray-400 shrink-0">Codec</dt>
          <dd class="text-gray-900 dark:text-white tabular-nums">{codecDisplay()}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-gray-500 dark:text-gray-400 shrink-0">Size</dt>
          <dd class="text-gray-900 dark:text-white tabular-nums">{formatBytes(local.fileSize)}</dd>
        </div>
      </dl>
    </div>
  );
};

export default VideoMetadataDisplay;
