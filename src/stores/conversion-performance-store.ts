import type { PerformanceWarning } from '@t/conversion-types';
import { createSignal } from 'solid-js';

const [, setPerformanceWarnings] = createSignal<PerformanceWarning[]>([]);
const [, setAutoAppliedRecommendation] = createSignal<boolean>(false);

export { setPerformanceWarnings, setAutoAppliedRecommendation };
