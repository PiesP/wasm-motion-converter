import type { ConversionResult } from '@t/conversion-types';
import { createSignal } from 'solid-js';

export const MAX_RESULTS = 10;

export const [conversionResults, setConversionResults] = createSignal<ConversionResult[]>([]);
