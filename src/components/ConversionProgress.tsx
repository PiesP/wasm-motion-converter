// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import Panel from '@components/ui/Panel';
import type { ConversionPhase } from '@t/v2-conversion-types';
import type { Component } from 'solid-js';
import { splitProps } from 'solid-js';
import ProgressBar from './ProgressBar';

/**
 * Conversion progress component props
 */
interface ConversionProgressProps {
  /** Current progress percentage (0-100) */
  progress: number;
  /** Current conversion status text */
  status: string;
  /** Optional detailed status message */
  statusMessage?: string;
  /** Whether to show elapsed time */
  showElapsedTime?: boolean;
  /** Conversion start timestamp in milliseconds */
  startTime?: number;
  /** ETA in seconds */
  estimatedSecondsRemaining?: number | null;
  /** Current frame number */
  currentFrame?: number;
  /** Total frame number */
  totalFrames?: number;
  /** Memory usage string */
  memoryUsage?: string | null;
  /** Active phase for multi-segment bar */
  phase?: ConversionPhase;
}

/**
 * Conversion progress display component
 */
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
    'memoryUsage',
    'phase',
  ]);
  const isInProgress = () => local.progress < 100;
  const ariaBusy = () => (isInProgress() ? true : undefined);

  return (
    <Panel
      class="p-6"
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
        memoryUsage={local.memoryUsage}
        phase={local.phase}
        layout="horizontal"
      />
    </Panel>
  );
};

export default ConversionProgress;
