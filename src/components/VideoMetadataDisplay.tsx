// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { VideoMetadata } from '@t/conversion-types';
import { formatBytes, formatDurationSeconds } from '@utils/format-utils';
import type { Component } from 'solid-js';
import { createMemo, splitProps } from 'solid-js';

const UNKNOWN_CODEC = 'unknown';

interface VideoMetadataDisplayProps {
  metadata: VideoMetadata;
  fileName: string;
  fileSize: number;
}

const VideoMetadataDisplay: Component<VideoMetadataDisplayProps> = (props) => {
  const { t, locale } = useLocale();
  const [local] = splitProps(props, ['metadata', 'fileName', 'fileSize']);

  const codecDisplay = createMemo(() =>
    local.metadata.codec === UNKNOWN_CODEC
      ? t('metadata.detecting')
      : local.metadata.codec.toUpperCase()
  );

  const bitrateDisplay = createMemo(() => {
    const bps = local.metadata.bitrate;
    if (!bps || bps <= 0) return t('metadata.detecting');
    if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
    return `${(bps / 1_000).toFixed(0)} Kbps`;
  });

  return (
    <div
      class="bg-bg-elevated border border-white/[0.06] rounded-lg p-4"
      data-testid="video-metadata"
    >
      <h3 class="text-xs font-medium text-text-tertiary mb-2 uppercase tracking-wide">
        {t('metadata.title')}
      </h3>
      <dl class="space-y-1.5 text-sm">
        <div class="flex justify-between gap-3">
          <dt class="text-text-tertiary shrink-0">{t('metadata.file')}</dt>
          <dd class="text-text-primary truncate text-right">{local.fileName}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-text-tertiary shrink-0">{t('metadata.resolution')}</dt>
          <dd class="text-text-primary tabular-nums">
            {local.metadata.width}×{local.metadata.height}
          </dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-text-tertiary shrink-0">{t('metadata.duration')}</dt>
          <dd class="text-text-primary tabular-nums">
            {formatDurationSeconds(local.metadata.duration, locale())}
          </dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-text-tertiary shrink-0">{t('metadata.fps')}</dt>
          <dd class="text-text-primary tabular-nums">{local.metadata.framerate}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-text-tertiary shrink-0">{t('metadata.codec')}</dt>
          <dd class="text-text-primary tabular-nums">{codecDisplay()}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-text-tertiary shrink-0">{t('metadata.bitrate')}</dt>
          <dd class="text-text-primary tabular-nums">{bitrateDisplay()}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-text-tertiary shrink-0">{t('metadata.size')}</dt>
          <dd class="text-text-primary tabular-nums">{formatBytes(local.fileSize, locale())}</dd>
        </div>
      </dl>
    </div>
  );
};

export default VideoMetadataDisplay;
