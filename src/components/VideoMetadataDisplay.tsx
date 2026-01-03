import type { Component } from 'solid-js';
import type { VideoMetadata } from '../types/conversion-types';
import { formatBytes } from '../utils/format-bytes';

interface VideoMetadataDisplayProps {
  metadata: VideoMetadata;
  fileName: string;
  fileSize: number;
}

const VideoMetadataDisplay: Component<VideoMetadataDisplayProps> = (props) => {
  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 mb-6">
      <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Input Video</h3>
      <div class="space-y-2 text-sm">
        <div class="flex justify-between">
          <span class="text-gray-600 dark:text-gray-400">File:</span>
          <span class="font-medium text-gray-900 dark:text-white truncate ml-2">
            {props.fileName}
          </span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-600 dark:text-gray-400">Resolution:</span>
          <span class="font-medium text-gray-900 dark:text-white">
            {props.metadata.width}x{props.metadata.height}
          </span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-600 dark:text-gray-400">Duration:</span>
          <span class="font-medium text-gray-900 dark:text-white">
            {formatDuration(props.metadata.duration)}
          </span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-600 dark:text-gray-400">Codec:</span>
          <span class="font-medium text-gray-900 dark:text-white uppercase">
            {props.metadata.codec}
          </span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-600 dark:text-gray-400">File Size:</span>
          <span class="font-medium text-gray-900 dark:text-white">
            {formatBytes(props.fileSize)}
          </span>
        </div>
      </div>
    </div>
  );
};

export default VideoMetadataDisplay;
