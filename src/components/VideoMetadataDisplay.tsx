// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { VideoMetadata } from '@t/conversion-types';
import { formatBytes, formatDurationSeconds } from '@utils/format-utils';
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
  const { locale } = useLocale();
  const [local] = splitProps(props, ['metadata', 'fileName', 'fileSize']);

  const codecDisplay = createMemo(() =>
    local.metadata.codec === UNKNOWN_CODEC ? DETECTING_LABEL : local.metadata.codec.toUpperCase()
  );

  return (
    <div
      class="bg-[#191a1b] border border-white/[0.06] rounded-lg p-4"
      data-testid="video-metadata"
    >
      <h3 class="text-xs font-medium text-[#8a8f98] mb-2 uppercase tracking-wide">Input Video</h3>
      <dl class="space-y-1.5 text-sm">
        <div class="flex justify-between gap-3">
          <dt class="text-[#8a8f98] shrink-0">File</dt>
          <dd class="text-[#f7f8f8] truncate text-right">{local.fileName}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-[#8a8f98] shrink-0">Resolution</dt>
          <dd class="text-[#f7f8f8] tabular-nums">
            {local.metadata.width}×{local.metadata.height}
          </dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-[#8a8f98] shrink-0">Duration</dt>
          <dd class="text-[#f7f8f8] tabular-nums">
            {formatDurationSeconds(local.metadata.duration, locale())}
          </dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-[#8a8f98] shrink-0">FPS</dt>
          <dd class="text-[#f7f8f8] tabular-nums">{local.metadata.framerate}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-[#8a8f98] shrink-0">Codec</dt>
          <dd class="text-[#f7f8f8] tabular-nums">{codecDisplay()}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-[#8a8f98] shrink-0">Size</dt>
          <dd class="text-[#f7f8f8] tabular-nums">{formatBytes(local.fileSize, locale())}</dd>
        </div>
      </dl>
    </div>
  );
};

export default VideoMetadataDisplay;
