import type { ErrorContext } from '@t/conversion-types';
import { createSignal } from 'solid-js';

export const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
export const [errorContext, setErrorContext] = createSignal<ErrorContext | null>(null);
