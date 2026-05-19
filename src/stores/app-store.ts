import type { AppState } from '@t/app-types';
import { createSignal } from 'solid-js';

export const [appState, setAppState] = createSignal<AppState>('idle');
export const [loadingProgress, setLoadingProgress] = createSignal<number>(0);
export const [loadingStatusMessage, setLoadingStatusMessage] = createSignal<string>('');
export const [environmentSupported, setEnvironmentSupported] = createSignal<boolean>(true);
