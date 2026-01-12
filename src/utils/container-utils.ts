/**
 * Container Utils
 *
 * Pure helpers for detecting container formats.
 */

import type { ContainerFormat } from '@t/video-pipeline-types';

const getExtensionLower = (fileName: string): string | null => {
  const parts = fileName.split('.');
  if (parts.length < 2) {
    return null;
  }
  const last = parts.at(-1);
  return last ? last.toLowerCase() : null;
};

/**
 * Detect container format from a File name.
 */
export function detectContainerFormat(file: File): ContainerFormat {
  const ext = getExtensionLower(file.name);

  switch (ext) {
    case 'mp4':
      return 'mp4';
    case 'mov':
      return 'mov';
    case 'm4v':
      return 'm4v';
    case 'webm':
      return 'webm';
    case 'mkv':
      return 'mkv';
    case 'avi':
      return 'avi';
    case 'wmv':
      return 'wmv';
    default:
      return 'unknown';
  }
}

/**
 * Whether this container is eligible for the WebCodecs demuxer path.
 */
export function isDemuxableContainer(container: ContainerFormat): boolean {
  return (
    container === 'mp4' ||
    container === 'mov' ||
    container === 'm4v' ||
    container === 'webm' ||
    container === 'mkv'
  );
}
