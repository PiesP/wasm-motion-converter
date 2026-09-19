// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import FileDropzone from '@components/FileDropzone';
import ResultPreview from '@components/ResultPreview';
import { LocaleProvider } from '@hooks/use-locale';
import type { Locale } from '@t/i18n-types';
import { render } from 'solid-js/web';

function replaceAppWithHarness(testId: string): HTMLDivElement {
  const host = document.createElement('div');
  host.dataset.testid = testId;
  document.querySelector('[data-testid="app"]')?.replaceWith(host);
  return host;
}

export function mountCompactProgressHarness(locale: Locale): () => void {
  const host = replaceAppWithHarness('compact-progress-harness');
  return render(
    () => (
      <LocaleProvider initialLocale={locale}>
        <FileDropzone
          disabled
          estimatedSecondsRemaining={42}
          fileName="active-conversion.mp4"
          fileSize={9}
          memoryUsage="64 MB / 512 MB (13%)"
          metadataSummary="1920×1080 · 0:12 · 30fps · 9 B"
          onCancel={() => {}}
          onFileSelected={() => {}}
          phase="encoding"
          previewUrl="/test-video-ci-h264.mp4"
          progress={84}
          showElapsedTime
          startTime={performance.now() - 12_000}
          status={
            locale === 'ar'
              ? 'جارٍ ترميز الإطارات المتحركة الطويلة'
              : 'Encoding animation frames'
          }
        />
      </LocaleProvider>
    ),
    host
  );
}

export function mountResultPreviewHarness(): () => void {
  const host = replaceAppWithHarness('result-preview-harness');
  return render(
    () => (
      <LocaleProvider initialLocale="en">
        <ResultPreview
          originalName="sample.mp4"
          originalSize={1_000}
          outputBlob={new Blob(['result'], { type: 'image/gif' })}
          outputWidth={320}
          outputHeight={180}
          settings={{
            format: 'gif',
            quality: 'medium',
            scale: 1,
            trimStart: 0,
            trimEnd: 0,
            smartFrameSkip: 'off',
          }}
        />
      </LocaleProvider>
    ),
    host
  );
}
