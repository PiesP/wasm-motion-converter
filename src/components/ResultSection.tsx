// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import ResultPreview from '@components/ResultPreview';
import type { ConversionResult } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { For, Show } from 'solid-js';

interface ResultSectionProps {
  results: ConversionResult[];
}

const ResultSection: Component<ResultSectionProps> = (props) => {
  return (
    <Show when={props.results.length > 0}>
      <div class="mt-8 space-y-6 animate-crossfade" data-testid="result-section">
        <For each={props.results}>
          {(result) => (
            <ResultPreview
              conversionDurationSeconds={result.conversionDurationSeconds}
              originalName={result.originalName}
              originalSize={result.originalSize}
              outputBlob={result.outputBlob}
              settings={result.settings}
            />
          )}
        </For>
      </div>
    </Show>
  );
};

export default ResultSection;
