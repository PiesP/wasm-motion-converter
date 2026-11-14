// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { demuxVideo } from '@services/demuxer-service';
import { extractVideoMetadata } from '@services/video-metadata';
import type { VideoMetadata } from '@t/conversion-types';

type IndexSnapshot = {
  version: 1;
  generation: number;
  sourceSize: number;
  fingerprint: string;
  bytes: ArrayBuffer;
};
type OwnedIndexModule = {
  beginOwnedInputSelection: (source: Blob) => number;
  clearOwnedInputSelection: () => void;
  copyOwnedInputIndex: (
    source: Blob,
    descriptionBytes: number,
    trimStart: number
  ) => IndexSnapshot | null;
};
type OwnedCoreModule = {
  createOwnedDemuxSession: (source: Blob) => Promise<{
    analyze: () => Promise<unknown>;
    transferStats: Record<string, number>;
    release: () => void;
  }>;
};

// The common entry builds against both the MediaBunny baseline and the candidate.
// Only the candidate checkout has these modules. Vite resolves the literal glob
// at build time; no production route is replaced or mocked.
const indexModules = import.meta.glob('../../../src/services/owned-input-index-cache.ts', {
  eager: true,
});
const coreModules = import.meta.glob('../../../src/services/owned-demux-core.ts', {
  eager: true,
});
const indexModule = Object.values(indexModules)[0] as OwnedIndexModule | undefined;
const coreModule = Object.values(coreModules)[0] as OwnedCoreModule | undefined;

export const engine = indexModule ? 'owned-rust-wasm' : 'mediabunny';

export function select(source: Blob): void {
  indexModule?.beginOwnedInputSelection(source);
}

export function clearSelection(): void {
  indexModule?.clearOwnedInputSelection();
}

export async function metadata(source: Blob): Promise<VideoMetadata> {
  return extractVideoMetadata(source);
}

export async function seek(source: Blob, selected: VideoMetadata, trimStart: number) {
  if (!selected.config) throw new Error('Metadata has no decoder configuration');
  const snapshot = indexModule?.copyOwnedInputIndex(
    source,
    selected.config.description?.byteLength ?? 0,
    trimStart
  );
  const transferStartMs = performance.now();
  const transferred = structuredClone(
    { source, snapshot },
    snapshot ? { transfer: [snapshot.bytes] } : undefined
  );
  const hostTransferMs = performance.now() - transferStartMs;
  const request = {
    inputBlob: transferred.source,
    ...(transferred.snapshot ? { indexSnapshot: transferred.snapshot } : {}),
    fileName: 'benchmark.mp4',
    format: 'gif' as const,
    quality: 'medium' as const,
    scale: 1,
    trimStart,
    trimEnd: 0,
    maxMemoryMB: 512,
  };
  const result = await demuxVideo(request, selected);
  try {
    for await (const chunk of result.chunks) {
      return {
        chunk,
        indexRoute: 'indexRoute' in result ? result.indexRoute : 'not-applicable',
        indexSnapshotBytes: 'indexSnapshotBytes' in result ? result.indexSnapshotBytes : 0,
        hostTransferMs,
      };
    }
    throw new Error('Seek produced no first encoded packet');
  } finally {
    result.dispose?.();
  }
}

/** Diagnostic pass after all timed samples; never attributed to the timed instance. */
export async function diagnosticOwnedCapacity(source: Blob) {
  if (!coreModule) return null;
  const session = await coreModule.createOwnedDemuxSession(source);
  try {
    await session.analyze();
    return session.transferStats;
  } finally {
    session.release();
  }
}
