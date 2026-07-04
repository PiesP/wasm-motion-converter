// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import ResultPreview from '@components/ResultPreview';
import { useLocale } from '@hooks/use-locale';
import type { ConversionResult } from '@t/conversion-types';
import type { Component } from 'solid-js';
import { For, Show } from 'solid-js';

interface ResultSectionProps {
  results: ConversionResult[];
}

const ResultSection: Component<ResultSectionProps> = (props) => {
  const { t } = useLocale();
  return (
    <Show when={props.results.length > 0}>
      <div
        class="mt-8 space-y-6 animate-crossfade result-section-deferred"
        data-testid="result-section"
      >
        <h2 class="text-lg font-semibold text-[#f7f8f8]">{t('result.heading')}</h2>
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
