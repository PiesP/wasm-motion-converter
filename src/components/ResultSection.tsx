// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { ConversionResult } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { For, lazy, Show, Suspense } from 'solid-js';

const ResultPreview = lazy(() => import('@components/ResultPreview'));

interface ResultSectionProps {
  results: ConversionResult[];
}

const ResultSection: Component<ResultSectionProps> = (props) => {
  return (
    <Show when={props.results.length > 0}>
      <div class="mt-8 space-y-6" data-testid="result-section">
        <For each={props.results}>
          {(result) => (
            <Suspense
              fallback={<div class="h-96 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />}
            >
              <ResultPreview
                conversionDurationSeconds={result.conversionDurationSeconds}
                originalName={result.originalName}
                originalSize={result.originalSize}
                outputBlob={result.outputBlob}
                settings={result.settings}
              />
            </Suspense>
          )}
        </For>
      </div>
    </Show>
  );
};

export default ResultSection;
