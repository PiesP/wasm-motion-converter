// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import Panel from '@components/ui/Panel';
import { conversionElapsedMs, conversionFps } from '@stores/conversion-store';
import type { ProgressPhase } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { splitProps } from 'solid-js';
import ProgressBar from './ProgressBar';

interface ConversionProgressProps {
  progress: number;
  status: string;
  statusMessage?: string | undefined;
  showElapsedTime?: boolean | undefined;
  startTime?: number | undefined;
  estimatedSecondsRemaining?: (number | null) | undefined;
  currentFrame?: number | undefined;
  totalFrames?: number | undefined;
  outputFrames?: number | undefined;
  memoryUsage?: (string | null) | undefined;
  phase?: ProgressPhase | undefined;
}

const ConversionProgress: Component<ConversionProgressProps> = (props) => {
  const [local] = splitProps(props, [
    'progress',
    'status',
    'statusMessage',
    'showElapsedTime',
    'startTime',
    'estimatedSecondsRemaining',
    'currentFrame',
    'totalFrames',
    'outputFrames',
    'memoryUsage',
    'phase',
  ]);
  const isInProgress = () => local.progress < 100;
  const ariaBusy = () => (isInProgress() ? true : undefined);

  return (
    <Panel
      class="p-4"
      role="region"
      ariaLabel="Video conversion progress"
      ariaLive="polite"
      ariaBusy={ariaBusy()}
      data-testid="conversion-progress"
    >
      <ProgressBar
        progress={local.progress}
        status={local.status}
        statusMessage={local.statusMessage}
        showSpinner={true}
        showElapsedTime={local.showElapsedTime}
        startTime={local.startTime}
        estimatedSecondsRemaining={local.estimatedSecondsRemaining}
        currentFrame={local.currentFrame}
        totalFrames={local.totalFrames}
        outputFrames={local.outputFrames}
        memoryUsage={local.memoryUsage}
        phase={local.phase}
        fps={conversionFps()}
        elapsedMs={conversionElapsedMs()}
        layout="horizontal"
      />
    </Panel>
  );
};

export default ConversionProgress;
