import Panel from '@components/ui/panel';
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
}

/**
 * Conversion progress display component
 *
 * Displays a progress bar with status information for ongoing video conversions.
 * Includes accessibility features for screen readers and keyboard users.
 *
 * @example
 * ```tsx
 * <ConversionProgress
 *   progress={45}
 *   status="Converting to GIF..."
 *   statusMessage="Processing frame 450/1000"
 *   showElapsedTime={true}
 *   startTime={Date.now()}
 * />
 * ```
 */
const ConversionProgress: Component<ConversionProgressProps> = (props) => {
  const [local] = splitProps(props, [
    'progress',
    'status',
    'statusMessage',
    'showElapsedTime',
    'startTime',
  ]);
  const isInProgress = () => local.progress < 100;

  return (
    <Panel
      class="p-6"
      role="region"
      ariaLabel="Video conversion progress"
      ariaLive="polite"
      ariaBusy={isInProgress()}
    >
      <ProgressBar
        progress={local.progress}
        status={local.status}
        statusMessage={local.statusMessage}
        showSpinner={true}
        showElapsedTime={local.showElapsedTime}
        startTime={local.startTime}
        layout="horizontal"
      />
    </Panel>
  );
};

export default ConversionProgress;
