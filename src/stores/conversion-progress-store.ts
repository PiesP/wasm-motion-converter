import { createSignal } from 'solid-js';

export const [conversionProgress, setConversionProgress] = createSignal<number>(0);
export const [conversionStatusMessage, setConversionStatusMessage] = createSignal<string>('');
