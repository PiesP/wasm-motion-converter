// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** One selected Blob's bounded logical demux index, owned by the main realm. */
export const MAX_OWNED_INDEX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
// Standalone admission constants avoid a conversion-types -> constants cycle.
// Focused tests assert that these stay aligned with the shared resource policy.
const DEMUX_MEMORY_BUDGET_BYTES = 128 * 1024 * 1024;
const ENCODED_PACKET_BUDGET_BYTES = 16 * 1024 * 1024;
const MP4_METADATA_BUDGET_BYTES = 32 * 1024 * 1024;
const MAX_WASM_CAPACITY_BYTES = 64 * 1024 * 1024;
export const MAX_OWNED_INDEX_DESCRIPTION_BYTES = 1024 * 1024;
const MAX_LOGICAL_PACKETS = Math.floor(MP4_METADATA_BUDGET_BYTES / 48);
const MAX_PACKET_BYTES = ENCODED_PACKET_BUDGET_BYTES - 1024;
const HEADER_WINDOW_OVERLAP_BYTES = 2 * 64 * 1024;

export type OwnedIndexAdmission = Readonly<{
  packetCount: number;
  maxPacketBytes: number;
  descriptionBytes: number;
}>;

const conservativeAdmission: OwnedIndexAdmission = {
  packetCount: MAX_LOGICAL_PACKETS,
  maxPacketBytes: MAX_PACKET_BYTES,
  descriptionBytes: MAX_OWNED_INDEX_DESCRIPTION_BYTES,
};

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
  snapshot: { fingerprint: string; bytes: ArrayBuffer; admission: OwnedIndexAdmission } | null;
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
  signal?: AbortSignal,
  admission: OwnedIndexAdmission = conservativeAdmission
): boolean {
  if (signal?.aborted || selected?.source !== source || selected.generation !== expectedGeneration)
    return false;
  if (
    bytes.byteLength < 96 ||
    bytes.byteLength > MAX_OWNED_INDEX_SNAPSHOT_BYTES ||
    !/^[0-9a-f]{64}$/.test(fingerprint)
  )
    throw new RangeError('Owned demux index snapshot exceeds its admitted envelope');
  if (
    !Number.isSafeInteger(admission.packetCount) ||
    admission.packetCount < 0 ||
    admission.packetCount > MAX_LOGICAL_PACKETS ||
    !Number.isSafeInteger(admission.maxPacketBytes) ||
    admission.maxPacketBytes < 0 ||
    admission.maxPacketBytes > MAX_PACKET_BYTES ||
    !Number.isSafeInteger(admission.descriptionBytes) ||
    admission.descriptionBytes < 0 ||
    admission.descriptionBytes > MAX_OWNED_INDEX_DESCRIPTION_BYTES
  )
    throw new RangeError('Owned demux index admission statistics are invalid');
  selected.snapshot = { bytes, fingerprint, admission };
  return true;
}

/** Each job receives a separately owned copy; the idle master stays available. */
export function copyOwnedInputIndex(
  source: Blob,
  configDescriptionBytes: number = MAX_OWNED_INDEX_DESCRIPTION_BYTES,
  trimStart = 1
): OwnedInputIndexSnapshot | null {
  if (selected?.source !== source || !selected.snapshot) return null;
  const { bytes, fingerprint, admission } = selected.snapshot;
  if (bytes.byteLength < 96 || bytes.byteLength > MAX_OWNED_INDEX_SNAPSHOT_BYTES)
    throw new RangeError('Owned demux index snapshot changed after publication');
  if (
    !Number.isSafeInteger(configDescriptionBytes) ||
    configDescriptionBytes < 0 ||
    configDescriptionBytes > MAX_OWNED_INDEX_DESCRIPTION_BYTES ||
    !Number.isFinite(trimStart) ||
    trimStart < 0
  ) {
    selected.snapshot = null;
    return null;
  }
  const descriptionReserve = Math.max(
    2 * admission.descriptionBytes,
    admission.descriptionBytes + configDescriptionBytes
  );
  const seekWorkspace = trimStart > 0 ? admission.packetCount * 12 : 0;
  // Fail the prospective optimization before a job starts if the maximum
  // permitted WASM capacity and both live index copies would leave less than
  // one packet of decoder queue credit. The selected master is evicted too.
  const minimumChunkCredit = admission.maxPacketBytes + 1024;
  const remainingChunkCredit =
    DEMUX_MEMORY_BUDGET_BYTES -
    MAX_WASM_CAPACITY_BYTES -
    admission.maxPacketBytes -
    ENCODED_PACKET_BUDGET_BYTES -
    descriptionReserve -
    HEADER_WINDOW_OVERLAP_BYTES -
    seekWorkspace -
    2 * bytes.byteLength;
  if (remainingChunkCredit < minimumChunkCredit) {
    selected.snapshot = null;
    return null;
  }
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
