import { createSignal } from 'solid-js';
import type { AppState } from '../types/app-types';

export const [appState, setAppState] = createSignal<AppState>('idle');
export const [ffmpegLoaded, setFFmpegLoaded] = createSignal(false);
export const [loadingProgress, setLoadingProgress] = createSignal(0);
export const [environmentSupported, setEnvironmentSupported] = createSignal(true);
