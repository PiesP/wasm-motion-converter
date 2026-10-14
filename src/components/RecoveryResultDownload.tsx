// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ConversionResult } from '@t/conversion-types';
import type { TFunction } from '@t/i18n-types';
import { resultDownloadName } from '@utils/result-download';
import { type Component, For, onCleanup } from 'solid-js';

const RecoveryResultDownload: Component<{ results: ConversionResult[]; t: TFunction }> = (
  props
) => (
  <For each={props.results}>
    {(result) => {
      // The retained Blob remains owned by the conversion store. This URL is only
      // a view handle, revoked when this minimal fallback leaves the DOM.
      const url = URL.createObjectURL(result.outputBlob);
      onCleanup(() => URL.revokeObjectURL(url));
      const name = resultDownloadName(result.originalName, result.outputBlob.type);
      return (
        <a
          href={url}
          download={name}
          class="inline-flex items-center rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground"
          data-testid="recovery-result-download"
        >
          {props.t('result.downloadFile', {
            format: result.outputBlob.type === 'image/gif' ? 'GIF' : 'WEBP',
            fileName: name,
          })}
        </a>
      );
    }}
  </For>
);

export default RecoveryResultDownload;
