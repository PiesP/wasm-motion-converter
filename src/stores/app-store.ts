import { createSignal } from 'solid-js';
import type { AppState } from '../types/app-types';

export const [appState, setAppState] = createSignal<AppState>('idle');
export const [loadingProgress, setLoadingProgress] = createSignal(0);
export const [loadingStatusMessage, setLoadingStatusMessage] = createSignal('');
export const [environmentSupported, setEnvironmentSupported] = createSignal(true);
