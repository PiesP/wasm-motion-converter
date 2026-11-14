// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** One selected Blob's bounded logical demux index, owned by the main realm. */
export const MAX_OWNED_INDEX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export type OwnedInputIndexSnapshot = Readonly<{
  version: 1;
  generation: number;
  sourceSize: number;
  fingerprint: string;
  bytes: ArrayBuffer;
}>;

type SelectedInput = {
  source: Blob;
  generation: number;
  snapshot: { fingerprint: string; bytes: ArrayBuffer } | null;
};

let generation = 0;
let selected: SelectedInput | null = null;

/** A new choice invalidates older analyses, including choices rejected by validation. */
export function beginOwnedInputSelection(source: Blob): number {
  if (
    !Number.isSafeInteger(source.size) ||
    source.size < 0 ||
    generation >= Number.MAX_SAFE_INTEGER
  )
    throw new RangeError('Owned input selection generation or size is invalid');
  generation++;
  selected = { source, generation, snapshot: null };
  return generation;
}

/** Clearing an older analysis must not discard a newer selected input. */
export function clearOwnedInputSelection(expectedGeneration?: number): void {
  if (expectedGeneration !== undefined && selected?.generation !== expectedGeneration) return;
  if (generation >= Number.MAX_SAFE_INTEGER)
    throw new RangeError('Owned input selection generation is exhausted');
  generation++;
  selected = null;
}

export function activeOwnedInputGeneration(source: Blob): number | null {
  return selected?.source === source ? selected.generation : null;
}

/** Takes ownership of the export buffer; callers must never mutate it afterward. */
export function publishOwnedInputIndex(
  source: Blob,
  expectedGeneration: number,
  bytes: ArrayBuffer,
  fingerprint: string,
  signal?: AbortSignal
): boolean {
  if (signal?.aborted || selected?.source !== source || selected.generation !== expectedGeneration)
    return false;
  if (
    bytes.byteLength < 96 ||
    bytes.byteLength > MAX_OWNED_INDEX_SNAPSHOT_BYTES ||
    !/^[0-9a-f]{64}$/.test(fingerprint)
  )
    throw new RangeError('Owned demux index snapshot exceeds its admitted envelope');
  selected.snapshot = { bytes, fingerprint };
  return true;
}

/** Each job receives a separately owned copy; the idle master stays available. */
export function copyOwnedInputIndex(source: Blob): OwnedInputIndexSnapshot | null {
  if (selected?.source !== source || !selected.snapshot) return null;
  const { bytes, fingerprint } = selected.snapshot;
  if (bytes.byteLength < 96 || bytes.byteLength > MAX_OWNED_INDEX_SNAPSHOT_BYTES)
    throw new RangeError('Owned demux index snapshot changed after publication');
  return {
    version: 1,
    generation: selected.generation,
    sourceSize: source.size,
    fingerprint,
    bytes: bytes.slice(0),
  };
}

/** Size and shape are checked again at the Worker trust boundary. */
export function isOwnedInputIndexSnapshot(value: unknown): value is OwnedInputIndexSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<OwnedInputIndexSnapshot>;
  return (
    candidate.version === 1 &&
    Number.isSafeInteger(candidate.generation) &&
    candidate.generation! > 0 &&
    Number.isSafeInteger(candidate.sourceSize) &&
    candidate.sourceSize! >= 0 &&
    typeof candidate.fingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(candidate.fingerprint) &&
    candidate.bytes instanceof ArrayBuffer &&
    candidate.bytes.byteLength >= 96 &&
    candidate.bytes.byteLength <= MAX_OWNED_INDEX_SNAPSHOT_BYTES
  );
}
