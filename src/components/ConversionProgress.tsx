import type { Component } from 'solid-js';
import ProgressBar from './ProgressBar';

interface ConversionProgressProps {
  progress: number;
  status: string;
  statusMessage?: string;
  showElapsedTime?: boolean;
  startTime?: number;
}

const ConversionProgress: Component<ConversionProgressProps> = (props) => {
  return (
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6">
      <ProgressBar
        progress={props.progress}
        status={props.status}
        statusMessage={props.statusMessage}
        showSpinner={true}
        showElapsedTime={props.showElapsedTime}
        startTime={props.startTime}
        layout="horizontal"
      />
    </div>
  );
};

export default ConversionProgress;
