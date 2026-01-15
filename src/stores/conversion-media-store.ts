import type { VideoMetadata } from '@t/conversion-types';
import { createSignal } from 'solid-js';

export const [inputFile, setInputFile] = createSignal<File | null>(null);
export const [videoMetadata, setVideoMetadata] = createSignal<VideoMetadata | null>(null);
export const [videoPreviewUrl, setVideoPreviewUrl] = createSignal<string | null>(null);
