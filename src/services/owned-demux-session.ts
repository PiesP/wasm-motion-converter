// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Host-owned Blob or ArrayBuffer ranges for the bounded conversion-owned Rust parser. */

import { schedulerYield as yieldToMain } from '@piesp/browser-core/util';
import { MAX_FILE_SIZE } from '@utils/constants';

import {
  EXTENDED_MP4_HEADER_BYTES,
  hasExtendedMp4Prefix,
  ownedInputLimit,
} from './owned-demux-intake';
import {
  ownedReadCreditStats,
  readOwnedRange,
  readOwnedRangeWithLease,
  tryAcquireOwnedReadLease,
  type OwnedReadLease,
} from './owned-demux-source-reads';

const ABI_VERSION = 4;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_STEP_BYTES = 8 * 1024;
const MAX_PACKET_BYTES = 16 * 1024 * 1024 - 1024;
const PACKET_WINDOW_BYTES = 64 * 1024;
const MAX_WASM_CAPACITY_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_TRACK_PACKETS = 100_000_000;
const EVENT_BYTES = 64;
const SEEK_KEY_BYTES = Uint32Array.BYTES_PER_ELEMENT + Float64Array.BYTES_PER_ELEMENT;
const MAX_STEPS = 2_000_000;
let nextSessionId = 1;

type DemuxExports = {
  memory: WebAssembly.Memory;
  demux_abi_version(): number;
  demux_init(lo: number, hi: number): number;
  demux_input_ptr(): number;
  demux_step(credit: number): number;
  demux_feed(length: number): number;
  demux_track(): number;
  demux_description_ptr(): number;
  demux_codec_ptr(): number;
  demux_packet_count(): number;
  demux_packet(index: number): number;
  demux_query_packet_begin(index: number): number;
  demux_query_packet_step(credit: number): number;
  demux_query_packet_end(): number;
  demux_index_info(): number;
  demux_seek_begin(ticksLow: number, ticksHigh: number, beforeIndex: number): number;
  demux_seek_step(credit: number): number;
  demux_seek_end(): number;
  demux_packet_begin(index: number): number;
  demux_prepare_packets(maxPacket: number): number;
  demux_probe_vp9(prefixLength: number): number;
  demux_packet_feed(length: number): number;
  demux_packet_finish(): number;
  demux_snapshot_begin(): number;
  demux_snapshot_next(): number;
  demux_snapshot_import_begin(total: number): number;
  demux_snapshot_import_feed(length: number): number;
  demux_snapshot_import_step(): number;
  demux_release(): void;
};

type RangeSource = {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
};

type IndexInfo = Readonly<{
  mode: 'expanded' | 'compact';
  packetCount: number;
  maxPacketBytes: number;
  liveIndexBytes: number;
  seekWorkspaceBytes: number;
  reconstructs: boolean;
  resumablePacketQuery: boolean;
}>;

export type OwnedDemuxTrack = {
  codec: string;
  codecString: string | null;
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  colorPrimaries: number;
  colorTransfer: number;
  colorMatrix: number;
  colorFullRange: -1 | 0 | 1;
  timescale: number;
  durationTicks: bigint;
  rotation: number;
  description: Uint8Array;
  packetCount: number;
  maxPacketBytes: number;
};

export type OwnedDemuxPacket = {
  index: number;
  sessionId: number;
  generation: number;
  offset: bigint;
  byteLength: number;
  dtsTicks: bigint;
  ptsTicks: bigint;
  durationTicks: bigint;
  key: boolean;
  sourceEnd: bigint | null;
};

export type OwnedDemuxTransferStats = {
  rangeReads: number;
  sourceReadBytes: number;
  inputCopiedToWasmBytes: number;
  snapshotCopiedFromWasmBytes: number;
  /** A subset of inputCopiedToWasmBytes, not an additional allocation. */
  snapshotCopiedToWasmBytes: number;
  packetReadBytes: number;
  stepCalls: number;
  wasmCapacityBytes: number;
  indexMode: 'expanded' | 'compact' | null;
  /** Already included in wasmCapacityBytes, not an additional reservation. */
  liveIndexBytes: number;
  maxPacketBytes: number;
  realmReadLiveBytes: number;
  realmReadRetiredBytes: number;
};

/** Only accepts a container key hint after inspecting the actual compressed frame. */
export async function verifyOwnedVideoKey(
  codec: string,
  description: Uint8Array,
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<boolean> {
  if (bytes.length === 0) return false;
  if (codec === 'VP80') return (bytes[0]! & 1) === 0;
  if (codec === 'VP90' || codec === 'vp09') {
    const first = bytes[0]!;
    if (first >>> 6 !== 2) return false;
    const profile = ((first >> 5) & 1) | ((first >> 3) & 2);
    return profile === 3 ? (first & 0x06) === 0 : (first & 0x0c) === 0;
  }
  if (codec === 'AV01' || codec === 'av01') {
    let at = 0;
    let units = 0;
    let lastYield = 0;
    // av1C can carry the Sequence Header while samples contain only frame OBUs.
    const configHeader = description.length > 6 ? description[4]! : 0;
    const configSize = description.length > 6 ? description[5]! : 0;
    let reduced =
      (description[0]! & 0x80) !== 0 &&
      ((configHeader >> 3) & 15) === 1 &&
      (configHeader & 2) !== 0 &&
      (configSize & 0x80) === 0 &&
      configSize > 0 &&
      (description[6]! & 0x08) !== 0;
    while (at < bytes.length) {
      signal?.throwIfAborted();
      const header = bytes[at++]!;
      if ((header & 0x80) !== 0) return false;
      const type = (header >> 3) & 15;
      if ((header & 4) !== 0) at++;
      if (at > bytes.length) return false;
      let size = bytes.length - at;
      if ((header & 2) !== 0) {
        size = 0;
        let shift = 0;
        for (;;) {
          const value = bytes[at++];
          if (value === undefined || shift > 49) return false;
          size += (value & 127) * 2 ** shift;
          if (!Number.isSafeInteger(size)) return false;
          if ((value & 128) === 0) break;
          shift += 7;
        }
      }
      if (at + size > bytes.length) return false;
      const first = bytes[at];
      if (type === 1 && first !== undefined) reduced = (first & 0x08) !== 0;
      if ((type === 3 || type === 6 || type === 7) && first !== undefined)
        return reduced || (first & 0xe0) === 0;
      at += size;
      if (++units >= 4096 || at - lastYield >= 64 * 1024) {
        units = 0;
        lastYield = at;
        await nextTask();
      }
    }
    return false;
  }
  if (codec === 'avc1' || codec === 'avc3' || codec === 'hvc1' || codec === 'hev1') {
    const avc = codec === 'avc1' || codec === 'avc3';
    const width =
      description.length >= 5
        ? avc
          ? (description[4]! & 3) + 1
          : description.length >= 22
            ? (description[21]! & 3) + 1
            : 0
        : 0;
    const classify = (type: number): boolean | null => {
      if (avc) {
        if (type >= 1 && type <= 4) return false;
        if (type === 5) return true;
      } else {
        if (type < 16) return false;
        if (type <= 23) return true;
      }
      return null;
    };
    if (width > 0) {
      let units = 0;
      let lastYield = 0;
      for (let at = 0; at < bytes.length;) {
        signal?.throwIfAborted();
        if (at + width > bytes.length) return false;
        let length = 0;
        for (let i = 0; i < width; i++) length = length * 256 + bytes[at + i]!;
        at += width;
        if (length < 1 || at + length > bytes.length) return false;
        const kind = avc ? bytes[at]! & 31 : (bytes[at]! >> 1) & 63;
        const result = classify(kind);
        if (result !== null) return result;
        at += length;
        if (++units >= 4096 || at - lastYield >= 64 * 1024) {
          units = 0;
          lastYield = at;
          await nextTask();
        }
      }
    } else {
      let at = 0;
      let scanned = 0;
      while (at + 3 < bytes.length) {
        signal?.throwIfAborted();
        if (
          bytes[at] === 0 &&
          bytes[at + 1] === 0 &&
          (bytes[at + 2] === 1 || (bytes[at + 2] === 0 && bytes[at + 3] === 1))
        ) {
          const start = at + (bytes[at + 2] === 1 ? 3 : 4);
          if (start >= bytes.length) return false;
          const kind = avc ? bytes[start]! & 31 : (bytes[start]! >> 1) & 63;
          const result = classify(kind);
          if (result !== null) return result;
          at = start + 1;
        } else {
          at++;
        }
        if (++scanned >= 64 * 1024) {
          scanned = 0;
          await nextTask();
        }
      }
    }
  }
  return false;
}

function eventView(wasm: DemuxExports, pointer: number): DataView {
  if (wasm.memory.buffer.byteLength > MAX_WASM_CAPACITY_BYTES)
    throw new Error('Owned demux WASM capacity limit exceeded');
  if (
    !Number.isInteger(pointer) ||
    pointer <= 0 ||
    pointer + EVENT_BYTES > wasm.memory.buffer.byteLength
  )
    throw new Error('Owned demux invalid ABI event pointer');
  return new DataView(wasm.memory.buffer, pointer, EVENT_BYTES);
}

function safeOffset(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Owned demux offset out of host range');
  return Number(value);
}

function checkSnapshotStatus(status: number): number {
  const word = status >>> 0;
  if (word < 0x8000_0000) return word;
  switch (word & 0x7fff_ffff) {
    case 1:
      throw new Error('Owned demux snapshot invalid input');
    case 2:
      throw new Error('Owned demux snapshot truncated input');
    case 3:
      throw new Error('Owned demux snapshot resource limit exceeded');
    case 4:
      throw new Error('Owned demux snapshot format unsupported');
    case 5:
      throw new Error('Owned demux snapshot value overflow');
    default:
      throw new Error('Owned demux snapshot ABI error code invalid');
  }
}

async function nextTask(): Promise<void> {
  await yieldToMain();
}

export class OwnedDemuxSession {
  private readonly wasm: DemuxExports;
  private readonly source: RangeSource;
  private readonly sourceIsBlob: boolean;
  private active = true;
  private ready = false;
  private analyzing = false;
  private packetReadInProgress = false;
  private packetQueryInProgress = false;
  private seeking = false;
  private snapshotOperation = false;
  private generation = 1;
  private readonly sessionId = nextSessionId++;
  private rangeReads = 0;
  private sourceReadBytes = 0;
  private inputCopiedToWasmBytes = 0;
  private snapshotCopiedFromWasmBytes = 0;
  private snapshotCopiedToWasmBytes = 0;
  private packetReadBytes = 0;
  private stepCalls = 0;
  private maxPacketBytes = 0;
  private indexInfo: IndexInfo | null = null;
  private preparedWasmCapacityBytes = 0;
  private analyzedTrack: OwnedDemuxTrack | null = null;
  private lastNativePacket: Readonly<OwnedDemuxPacket> | null = null;
  private packetWindowEnabled = false;
  private packetWindow: { start: number; bytes: Uint8Array; lease: OwnedReadLease } | null = null;

  /** Called only after the conversion's aggregate memory admission succeeds. */
  enablePacketReadWindow(): void {
    if (!this.active || !this.ready) throw new Error('Owned demux packet window unavailable');
    this.packetWindowEnabled = this.sourceIsBlob;
  }

  private evictPacketWindow(): void {
    const window = this.packetWindow;
    this.packetWindow = null;
    window?.lease.release();
  }

  /** Additional seek memory beyond the current WASM capacity, or the expanded JS heap. */
  get seekWorkspaceBytes(): number {
    if (!this.active || !this.ready || !this.indexInfo)
      throw new Error('Owned demux index unavailable');
    return this.indexInfo.seekWorkspaceBytes;
  }

  get transferStats(): OwnedDemuxTransferStats {
    const readCredit = ownedReadCreditStats();
    return {
      rangeReads: this.rangeReads,
      sourceReadBytes: this.sourceReadBytes,
      inputCopiedToWasmBytes: this.inputCopiedToWasmBytes,
      snapshotCopiedFromWasmBytes: this.snapshotCopiedFromWasmBytes,
      snapshotCopiedToWasmBytes: this.snapshotCopiedToWasmBytes,
      packetReadBytes: this.packetReadBytes,
      stepCalls: this.stepCalls,
      wasmCapacityBytes: this.wasm.memory.buffer.byteLength,
      indexMode: this.indexInfo?.mode ?? null,
      liveIndexBytes: this.indexInfo?.liveIndexBytes ?? 0,
      maxPacketBytes: this.maxPacketBytes,
      realmReadLiveBytes: readCredit.liveBytes,
      realmReadRetiredBytes: readCredit.retiredBytes,
    };
  }

  constructor(source: Blob | ArrayBuffer, module: WebAssembly.Module) {
    this.sourceIsBlob = source instanceof Blob;
    const rangeSource: RangeSource =
      source instanceof Blob
        ? source
        : {
            size: source.byteLength,
            slice: (start, end) => ({ arrayBuffer: async () => source.slice(start, end) }),
          };
    if (rangeSource.size < 8 || rangeSource.size > ownedInputLimit(source))
      throw new Error('Owned demux input size limit exceeded');
    const instance = new WebAssembly.Instance(module, {});
    const exports = instance.exports as unknown as Record<string, unknown>;
    if (
      !(exports.memory instanceof WebAssembly.Memory) ||
      (
        [
          'demux_abi_version',
          'demux_init',
          'demux_input_ptr',
          'demux_step',
          'demux_feed',
          'demux_track',
          'demux_description_ptr',
          'demux_codec_ptr',
          'demux_packet_count',
          'demux_packet',
          'demux_query_packet_begin',
          'demux_query_packet_step',
          'demux_query_packet_end',
          'demux_index_info',
          'demux_seek_begin',
          'demux_seek_step',
          'demux_seek_end',
          'demux_prepare_packets',
          'demux_probe_vp9',
          'demux_packet_begin',
          'demux_packet_feed',
          'demux_packet_finish',
          'demux_release',
          'demux_snapshot_begin',
          'demux_snapshot_next',
          'demux_snapshot_import_begin',
          'demux_snapshot_import_feed',
          'demux_snapshot_import_step',
        ] as const
      ).some((name) => typeof exports[name] !== 'function')
    )
      throw new Error('Owned demux ABI exports missing');
    this.wasm = instance.exports as unknown as DemuxExports;
    if (this.wasm.demux_abi_version() !== ABI_VERSION)
      throw new Error('Owned demux ABI version mismatch');
    this.source = rangeSource;
    const size = BigInt(rangeSource.size);
    const pointer = this.wasm.demux_init(Number(size & 0xffff_ffffn), Number(size >> 32n));
    if (!pointer) throw new Error('Owned demux initialization failed');
    eventView(this.wasm, pointer);
  }

  async analyze(signal?: AbortSignal): Promise<OwnedDemuxTrack> {
    if (!this.active || this.ready || this.analyzing || this.snapshotOperation)
      throw new Error('Owned demux session state invalid');
    this.analyzing = true;
    try {
      for (let steps = 0; steps < MAX_STEPS; steps++) {
        signal?.throwIfAborted();
        if (!this.active) throw new Error('Owned demux session released');
        this.stepCalls++;
        const event = eventView(this.wasm, this.wasm.demux_step(64));
        const status = event.getUint32(0, true);
        if (status === 1) {
          const offset = event.getBigUint64(8, true);
          const length = event.getUint32(16, true);
          const start = safeOffset(offset);
          if (length < 1 || length > 64 * 1024 || start + length > this.source.size)
            throw new Error('Owned demux invalid input request');
          const window = new Uint8Array(
            await readOwnedRange(this.source, start, start + length, signal)
          );
          this.rangeReads++;
          this.sourceReadBytes += window.byteLength;
          signal?.throwIfAborted();
          if (!this.active) throw new Error('Owned demux session released during read');
          if (window.length !== length) throw new Error('Owned demux truncated read');
          const destination = this.wasm.demux_input_ptr();
          if (destination <= 0 || destination + length > this.wasm.memory.buffer.byteLength)
            throw new Error('Owned demux invalid input destination');
          // No WASM call or growth occurs while the host writes this leased destination.
          new Uint8Array(this.wasm.memory.buffer, destination, length).set(window);
          this.inputCopiedToWasmBytes += window.byteLength;
          if (!this.wasm.demux_feed(length)) throw new Error('Owned demux input feed failed');
        } else if (status === 2) {
          await nextTask();
        } else if (status === 3) {
          let track = this.readTrackRecord();
          const info = await this.validateIndex(this.readIndexInfo(track.packetCount), signal);
          // The VP9 prefix probe can need presentation order from compact CTTS.
          this.indexInfo = info;
          if (track.codec === 'VP90') {
            await this.probeVp9(signal);
            track = this.readTrackRecord();
          }
          if (info.reconstructs && !this.wasm.demux_prepare_packets(this.maxPacketBytes))
            throw new Error('Owned demux packet workspace admission failed');
          this.preparedWasmCapacityBytes = this.wasm.memory.buffer.byteLength;
          track.maxPacketBytes = this.maxPacketBytes;
          this.indexInfo = info;
          this.ready = true;
          this.analyzedTrack = track;
          return track;
        } else if (status === 4) {
          throw new Error(`Owned demux parser error ${event.getUint32(4, true)}`);
        } else {
          throw new Error(`Owned demux invalid status ${status}`);
        }
      }
      throw new Error('Owned demux logical work limit exceeded');
    } catch (error) {
      this.release();
      throw error;
    } finally {
      this.analyzing = false;
    }
  }

  track(): OwnedDemuxTrack {
    if (!this.active || !this.ready) throw new Error('Owned demux track unavailable');
    return this.readTrackRecord();
  }

  /** Export only a logical index; the selected-source generation stays with its host owner. */
  async exportIndex(signal?: AbortSignal): Promise<ArrayBuffer | null> {
    if (
      !this.active ||
      !this.ready ||
      this.analyzing ||
      this.packetReadInProgress ||
      this.packetQueryInProgress ||
      this.seeking ||
      this.snapshotOperation
    )
      throw new Error('Owned demux snapshot lease invalid');
    this.snapshotOperation = true;
    try {
      signal?.throwIfAborted();
      const total = checkSnapshotStatus(this.wasm.demux_snapshot_begin());
      if (total === 0) return null;
      if (total < 64 + 64 + 40 + 4 || total > MAX_SNAPSHOT_BYTES)
        throw new Error('Owned demux snapshot size invalid');
      if (this.wasm.memory.buffer.byteLength + total + 16 * 1024 * 1024 > 128 * 1024 * 1024)
        throw new Error('Owned demux snapshot resource limit exceeded');
      const output = new Uint8Array(total);
      for (let at = 0; at < total;) {
        signal?.throwIfAborted();
        if (!this.active) throw new Error('Owned demux session released');
        const length = checkSnapshotStatus(this.wasm.demux_snapshot_next());
        if (length < 1 || length > SNAPSHOT_STEP_BYTES || at + length > total)
          throw new Error('Owned demux snapshot export failed');
        const pointer = this.wasm.demux_input_ptr();
        if (pointer <= 0 || pointer + length > this.wasm.memory.buffer.byteLength)
          throw new Error('Owned demux snapshot source invalid');
        output.set(new Uint8Array(this.wasm.memory.buffer, pointer, length), at);
        this.snapshotCopiedFromWasmBytes += length;
        at += length;
        if (this.wasm.memory.buffer.byteLength !== this.preparedWasmCapacityBytes)
          throw new Error('Owned demux snapshot changed WASM capacity');
        await nextTask();
      }
      signal?.throwIfAborted();
      if (!this.active) throw new Error('Owned demux session released');
      return output.buffer;
    } catch (error) {
      this.release();
      throw error;
    } finally {
      this.snapshotOperation = false;
    }
  }

  /** Import into a fresh conversion-owned instance. A malformed import is terminal. */
  async importIndex(snapshot: ArrayBuffer, signal?: AbortSignal): Promise<OwnedDemuxTrack> {
    if (
      !this.active ||
      this.ready ||
      this.analyzing ||
      this.packetReadInProgress ||
      this.packetQueryInProgress ||
      this.seeking ||
      this.snapshotOperation
    )
      throw new Error('Owned demux snapshot import state invalid');
    this.snapshotOperation = true;
    try {
      signal?.throwIfAborted();
      if (this.source.size > MAX_FILE_SIZE) {
        const prefix = await readOwnedRange(this.source, 0, EXTENDED_MP4_HEADER_BYTES, signal);
        this.rangeReads++;
        this.sourceReadBytes += prefix.byteLength;
        if (!hasExtendedMp4Prefix(new Uint8Array(prefix), this.source.size))
          throw new Error('Owned demux snapshot source is not range-backed MP4');
      }
      signal?.throwIfAborted();
      if (!this.active) throw new Error('Owned demux session released');
      const bytes = new Uint8Array(snapshot);
      if (bytes.byteLength < 64 + 64 + 40 + 4 || bytes.byteLength > MAX_SNAPSHOT_BYTES)
        throw new Error('Owned demux snapshot size invalid');
      if (
        this.wasm.memory.buffer.byteLength + bytes.byteLength + 16 * 1024 * 1024 >
        128 * 1024 * 1024
      )
        throw new Error('Owned demux snapshot resource limit exceeded');
      if (checkSnapshotStatus(this.wasm.demux_snapshot_import_begin(bytes.byteLength)) !== 1)
        throw new Error('Owned demux snapshot import admission failed');
      for (let at = 0; at < bytes.length;) {
        signal?.throwIfAborted();
        if (!this.active) throw new Error('Owned demux session released');
        const length = Math.min(SNAPSHOT_STEP_BYTES, bytes.length - at);
        const pointer = this.wasm.demux_input_ptr();
        if (pointer <= 0 || pointer + length > this.wasm.memory.buffer.byteLength)
          throw new Error('Owned demux snapshot destination invalid');
        new Uint8Array(this.wasm.memory.buffer, pointer, length).set(
          bytes.subarray(at, at + length)
        );
        this.inputCopiedToWasmBytes += length;
        this.snapshotCopiedToWasmBytes += length;
        if (checkSnapshotStatus(this.wasm.demux_snapshot_import_feed(length)) !== 1)
          throw new Error('Owned demux snapshot import feed failed');
        at += length;
        await nextTask();
      }
      for (let steps = 0; steps < MAX_STEPS; steps++) {
        signal?.throwIfAborted();
        if (!this.active) throw new Error('Owned demux session released');
        const status = checkSnapshotStatus(this.wasm.demux_snapshot_import_step());
        if (status === 0) throw new Error('Owned demux snapshot import invalid');
        if (status === 2) break;
        await nextTask();
        if (steps === MAX_STEPS - 1)
          throw new Error('Owned demux snapshot logical work limit exceeded');
      }
      const track = this.readTrackRecord();
      const info = this.readIndexInfo(track.packetCount);
      if (info.mode !== 'expanded')
        throw new Error('Owned demux compact snapshot import unsupported');
      const validated = await this.validateIndex(info, signal);
      signal?.throwIfAborted();
      if (!this.active) throw new Error('Owned demux session released');
      if (info.reconstructs && !this.wasm.demux_prepare_packets(this.maxPacketBytes))
        throw new Error('Owned demux snapshot packet workspace admission failed');
      this.preparedWasmCapacityBytes = this.wasm.memory.buffer.byteLength;
      track.maxPacketBytes = this.maxPacketBytes;
      this.indexInfo = validated;
      this.ready = true;
      this.analyzedTrack = track;
      return track;
    } catch (error) {
      this.release();
      throw error;
    } finally {
      this.snapshotOperation = false;
    }
  }

  private readIndexInfo(packetCount: number): IndexInfo {
    const view = eventView(this.wasm, this.wasm.demux_index_info());
    if (view.getUint32(0, true) !== 9) throw new Error('Owned demux invalid index ABI event');
    const mode = view.getUint32(4, true);
    const logicalCount = view.getUint32(8, true);
    const maxPacketBytes = view.getUint32(12, true);
    const liveIndexBytes = view.getUint32(16, true);
    const seekWorkspaceBytes = view.getUint32(20, true);
    const flags = view.getUint32(24, true);
    if (
      (mode !== 0 && mode !== 1) ||
      logicalCount !== packetCount ||
      maxPacketBytes < 1 ||
      maxPacketBytes > MAX_PACKET_BYTES ||
      liveIndexBytes < 1 ||
      liveIndexBytes > MAX_INDEX_BYTES ||
      seekWorkspaceBytes > MAX_INDEX_BYTES ||
      (flags & ~3) !== 0 ||
      (mode === 0 && (seekWorkspaceBytes !== 0 || (flags & 2) !== 0)) ||
      (mode === 1 &&
        ((flags & 1) !== 0 ||
          seekWorkspaceBytes + this.wasm.memory.buffer.byteLength > MAX_WASM_CAPACITY_BYTES))
    )
      throw new Error('Owned demux index ABI record invalid');
    return {
      mode: mode === 1 ? 'compact' : 'expanded',
      packetCount: logicalCount,
      maxPacketBytes,
      liveIndexBytes,
      seekWorkspaceBytes,
      reconstructs: (flags & 1) !== 0,
      resumablePacketQuery: (flags & 2) !== 0,
    };
  }

  private async validateIndex(info: IndexInfo, signal?: AbortSignal): Promise<IndexInfo> {
    this.maxPacketBytes = info.maxPacketBytes;
    if (info.mode === 'compact') return info;
    let keyCount = 0;
    let observedMax = 0;
    let observedReconstruction = false;
    for (let index = 0; index < info.packetCount; index++) {
      if (index % 256 === 0) {
        signal?.throwIfAborted();
        if (!this.active) throw new Error('Owned demux session released');
        await nextTask();
      }
      const packet = this.readPacketRecord(index);
      if (packet.key) keyCount++;
      observedMax = Math.max(observedMax, packet.byteLength);
      observedReconstruction ||= packet.sourceEnd !== null;
    }
    if (observedMax !== info.maxPacketBytes || observedReconstruction !== info.reconstructs)
      throw new Error('Owned demux index ABI summary mismatch');
    return { ...info, seekWorkspaceBytes: keyCount * SEEK_KEY_BYTES };
  }

  private readTrackRecord(): OwnedDemuxTrack {
    const view = eventView(this.wasm, this.wasm.demux_track());
    if (view.getUint32(0, true) !== 6) throw new Error('Owned demux invalid track event');
    const codec = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + 8, 4));
    const width = view.getUint32(12, true);
    const height = view.getUint32(16, true);
    const timescale = view.getUint32(20, true);
    const durationTicks = view.getBigUint64(24, true);
    const rotation = view.getUint32(32, true);
    const descriptionLength = view.getUint32(36, true);
    const displayWidth = view.getUint32(40, true);
    const displayHeight = view.getUint32(44, true);
    const colorPrimaries = view.getUint16(48, true);
    const colorTransfer = view.getUint16(50, true);
    const colorMatrix = view.getUint16(52, true);
    const colorFullRange = view.getInt8(54);
    const codecLength = view.getUint32(56, true);
    if (![-1, 0, 1].includes(colorFullRange)) throw new Error('Owned demux invalid color range');
    const pointer = this.wasm.demux_description_ptr();
    if (
      descriptionLength > 1024 * 1024 ||
      (descriptionLength > 0 &&
        (pointer <= 0 || pointer + descriptionLength > this.wasm.memory.buffer.byteLength))
    )
      throw new Error('Owned demux description out of range');
    const description = new Uint8Array(this.wasm.memory.buffer, pointer, descriptionLength).slice();
    const codecPointer = this.wasm.demux_codec_ptr();
    if (
      codecLength > 128 ||
      (codecLength > 0 &&
        (codecPointer <= 0 || codecPointer + codecLength > this.wasm.memory.buffer.byteLength))
    )
      throw new Error('Owned demux codec string out of range');
    const codecString =
      codecLength > 0
        ? new TextDecoder('ascii', { fatal: true }).decode(
            new Uint8Array(this.wasm.memory.buffer, codecPointer, codecLength)
          )
        : null;
    const packetCount = this.wasm.demux_packet_count();
    if (packetCount < 1 || packetCount > MAX_TRACK_PACKETS)
      throw new Error('Owned demux packet index limit exceeded');
    return {
      codec,
      codecString,
      width,
      height,
      displayWidth,
      displayHeight,
      colorPrimaries,
      colorTransfer,
      colorMatrix,
      colorFullRange: colorFullRange as -1 | 0 | 1,
      timescale,
      durationTicks,
      rotation,
      description,
      packetCount,
      maxPacketBytes: this.maxPacketBytes,
    };
  }

  packet(index: number): OwnedDemuxPacket {
    if (
      !this.active ||
      !this.ready ||
      this.snapshotOperation ||
      this.packetQueryInProgress ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= (this.indexInfo?.packetCount ?? 0)
    )
      throw new Error('Owned demux packet index invalid');
    if (this.indexInfo?.resumablePacketQuery) {
      if (this.lastNativePacket?.index !== index)
        throw new Error('Owned demux packet requires asynchronous query');
      return { ...this.readPacketRecord(index) };
    }
    return this.readPacketRecord(index);
  }

  /** Compact CTTS can require bounded presentation-order work for one packet. */
  async packetAsync(index: number, signal?: AbortSignal): Promise<OwnedDemuxPacket> {
    if (
      !this.active ||
      !this.ready ||
      this.analyzing ||
      this.packetReadInProgress ||
      this.packetQueryInProgress ||
      this.seeking ||
      this.snapshotOperation ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= (this.indexInfo?.packetCount ?? 0)
    )
      throw new Error('Owned demux packet query lease invalid');
    try {
      signal?.throwIfAborted();
      return await this.queryPacketRecord(index, signal);
    } catch (error) {
      this.evictPacketWindow();
      throw error;
    }
  }

  private readPacketRecord(index: number): OwnedDemuxPacket {
    const view = eventView(this.wasm, this.wasm.demux_packet(index));
    return this.packetFromEvent(index, view);
  }

  private packetFromEvent(index: number, view: DataView): OwnedDemuxPacket {
    if (view.getUint32(0, true) !== 5) throw new Error('Owned demux packet unavailable');
    const offset = view.getBigUint64(8, true);
    const byteLength = view.getUint32(16, true);
    const key = view.getUint32(20, true);
    const sourceEnd = view.getBigUint64(48, true);
    if (
      key > 1 ||
      byteLength < 1 ||
      byteLength > MAX_PACKET_BYTES ||
      (this.maxPacketBytes > 0 && byteLength > this.maxPacketBytes) ||
      (this.indexInfo?.mode === 'compact' && sourceEnd !== 0n) ||
      (sourceEnd === 0n && safeOffset(offset) + byteLength > this.source.size) ||
      (sourceEnd !== 0n && (sourceEnd <= offset || safeOffset(sourceEnd) > this.source.size))
    )
      throw new Error('Owned demux packet range invalid');
    return {
      index,
      sessionId: this.sessionId,
      generation: this.generation,
      offset,
      byteLength,
      sourceEnd: sourceEnd === 0n ? null : sourceEnd,
      key: key === 1,
      dtsTicks: view.getBigInt64(24, true),
      ptsTicks: view.getBigInt64(32, true),
      durationTicks: view.getBigUint64(40, true),
    };
  }

  private async queryPacketRecord(index: number, signal?: AbortSignal): Promise<OwnedDemuxPacket> {
    if (!this.active || this.packetQueryInProgress || !this.indexInfo)
      throw new Error('Owned demux packet query lease invalid');
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.indexInfo.packetCount)
      throw new Error('Owned demux packet index invalid');
    if (!this.indexInfo.resumablePacketQuery) return this.readPacketRecord(index);
    signal?.throwIfAborted();
    if (this.lastNativePacket?.index === index) {
      const current = this.readPacketRecord(index);
      this.lastNativePacket = Object.freeze(current);
      return { ...current };
    }
    this.packetQueryInProgress = true;
    this.lastNativePacket = null;
    let begun = false;
    try {
      if (this.wasm.demux_query_packet_begin(index) !== 1)
        throw new Error('Owned demux packet query start state invalid');
      begun = true;
      for (let steps = 0; steps < MAX_STEPS; steps++) {
        signal?.throwIfAborted();
        if (!this.active) throw new Error('Owned demux session released');
        const view = eventView(this.wasm, this.wasm.demux_query_packet_step(4096));
        if (
          this.preparedWasmCapacityBytes > 0 &&
          this.wasm.memory.buffer.byteLength !== this.preparedWasmCapacityBytes
        )
          throw new Error('Owned demux packet query changed WASM capacity');
        const tag = view.getUint32(0, true);
        if (tag === 5) {
          const current = this.packetFromEvent(index, view);
          this.lastNativePacket = Object.freeze(current);
          return { ...current };
        }
        if (tag !== 11) throw new Error('Owned demux packet query ABI event invalid');
        const state = view.getUint32(4, true);
        if (state === 4)
          throw new Error(`Owned demux packet query error ${view.getUint32(8, true)}`);
        if (state !== 1) throw new Error('Owned demux packet query ABI state invalid');
        await nextTask();
      }
      throw new Error('Owned demux packet query logical work limit exceeded');
    } finally {
      this.packetQueryInProgress = false;
      if (begun && this.active && this.wasm.demux_query_packet_end() !== 1)
        throw new Error('Owned demux packet query cleanup failed');
    }
  }

  async readPacket(packet: OwnedDemuxPacket, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.readPacketInternal(packet, signal, false);
  }

  private async readPacketInternal(
    packet: OwnedDemuxPacket,
    signal: AbortSignal | undefined,
    fromSeek: boolean
  ): Promise<ArrayBuffer> {
    if (
      !this.active ||
      !this.ready ||
      packet.sessionId !== this.sessionId ||
      packet.generation !== this.generation ||
      this.packetReadInProgress ||
      this.packetQueryInProgress ||
      (this.seeking && !fromSeek) ||
      this.snapshotOperation
    ) {
      this.evictPacketWindow();
      throw new Error('Owned demux packet lease invalid');
    }
    this.packetReadInProgress = true;
    try {
      signal?.throwIfAborted();
      const current = await this.queryPacketRecord(packet.index, signal);
      signal?.throwIfAborted();
      if (!this.active) throw new Error('Owned demux session released');
      if (
        current.offset !== packet.offset ||
        current.byteLength !== packet.byteLength ||
        current.sourceEnd !== packet.sourceEnd ||
        current.dtsTicks !== packet.dtsTicks ||
        current.ptsTicks !== packet.ptsTicks ||
        current.durationTicks !== packet.durationTicks ||
        current.key !== packet.key
      )
        throw new Error('Owned demux packet descriptor invalid');
      if (packet.sourceEnd !== null) {
        this.evictPacketWindow();
        return await this.readTsPacket(packet, signal);
      }
      const start = safeOffset(packet.offset);
      if (
        packet.byteLength < 1 ||
        packet.byteLength > MAX_PACKET_BYTES ||
        start + packet.byteLength > this.source.size
      )
        throw new Error('Owned demux packet range invalid');
      const data = await this.readOrdinaryPacket(start, packet.byteLength, signal);
      this.packetReadBytes += data.byteLength;
      signal?.throwIfAborted();
      if (!this.active || data.byteLength !== packet.byteLength)
        throw new Error('Owned demux packet read invalidated');
      return data;
    } catch (error) {
      this.evictPacketWindow();
      throw error;
    } finally {
      this.packetReadInProgress = false;
    }
  }

  private async readOrdinaryPacket(
    start: number,
    length: number,
    signal?: AbortSignal
  ): Promise<ArrayBuffer> {
    if (!this.packetWindowEnabled || length > PACKET_WINDOW_BYTES) {
      this.evictPacketWindow();
      const data = await readOwnedRange(this.source, start, start + length, signal);
      this.rangeReads++;
      this.sourceReadBytes += data.byteLength;
      return data;
    }
    {
      const window = this.packetWindow;
      if (window && start >= window.start && start + length <= window.start + window.bytes.length)
        return window.bytes.slice(start - window.start, start - window.start + length).buffer;
    }

    // The window and one independent small packet copy fit within the already
    // reserved 16 MiB host-read/packet overlap slot. The separate maxPacketBytes
    // reserve covers the returned packet, and the window retains realm read credit.
    this.evictPacketWindow();
    const end = Math.min(this.source.size, start + PACKET_WINDOW_BYTES);
    const lease = tryAcquireOwnedReadLease(end - start);
    if (!lease) {
      // Capacity is decided before I/O: a failed or short window read is terminal.
      const data = await readOwnedRange(this.source, start, start + length, signal);
      this.rangeReads++;
      this.sourceReadBytes += data.byteLength;
      return data;
    }
    const generation = this.generation;
    try {
      const data = await readOwnedRangeWithLease(this.source, start, end, lease, signal);
      this.rangeReads++;
      this.sourceReadBytes += data.byteLength;
      signal?.throwIfAborted();
      if (!this.active || generation !== this.generation)
        throw new Error('Owned demux packet read invalidated');
      if (data.byteLength !== end - start) throw new Error('Owned demux truncated read');
      const bytes = new Uint8Array(data);
      this.packetWindow = { start, bytes, lease };
      return bytes.slice(0, length).buffer;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private async readTsPacket(packet: OwnedDemuxPacket, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (this.wasm.memory.buffer.byteLength !== this.preparedWasmCapacityBytes)
      throw new Error('Owned demux packet workspace capacity changed');
    const end = safeOffset(packet.sourceEnd!);
    let at = safeOffset(packet.offset);
    if (!this.wasm.demux_packet_begin(packet.index))
      throw new Error('Owned demux packet reconstruction admission failed');
    if (this.wasm.memory.buffer.byteLength !== this.preparedWasmCapacityBytes)
      throw new Error('Owned demux packet workspace grew after preparation');
    while (at < end) {
      signal?.throwIfAborted();
      const length = Math.min(64 * 1024, end - at);
      const chunk = new Uint8Array(await readOwnedRange(this.source, at, at + length, signal));
      this.rangeReads++;
      this.sourceReadBytes += chunk.byteLength;
      signal?.throwIfAborted();
      if (!this.active || chunk.byteLength !== length)
        throw new Error('Owned demux packet source read invalidated');
      const destination = this.wasm.demux_input_ptr();
      if (destination <= 0 || destination + length > this.wasm.memory.buffer.byteLength)
        throw new Error('Owned demux packet destination invalid');
      new Uint8Array(this.wasm.memory.buffer, destination, length).set(chunk);
      this.inputCopiedToWasmBytes += length;
      if (!this.wasm.demux_packet_feed(length))
        throw new Error('Owned demux packet reconstruction failed');
      if (this.wasm.memory.buffer.byteLength !== this.preparedWasmCapacityBytes)
        throw new Error('Owned demux packet workspace grew after preparation');
      at += length;
      await nextTask();
    }
    const pointer = this.wasm.demux_packet_finish();
    if (this.wasm.memory.buffer.byteLength !== this.preparedWasmCapacityBytes)
      throw new Error('Owned demux packet workspace grew after preparation');
    if (pointer <= 0 || pointer + packet.byteLength > this.wasm.memory.buffer.byteLength)
      throw new Error('Owned demux packet reconstruction output invalid');
    const data = new Uint8Array(this.wasm.memory.buffer, pointer, packet.byteLength).slice().buffer;
    this.packetReadBytes += data.byteLength;
    return data;
  }

  private async probeVp9(signal?: AbortSignal): Promise<void> {
    const packetCount = this.wasm.demux_packet_count();
    for (let index = 0; index < packetCount; index++) {
      if (index % 256 === 0) {
        signal?.throwIfAborted();
        if (!this.active) throw new Error('Owned demux session released');
        await nextTask();
      }
      const packet = await this.queryPacketRecord(index, signal);
      if (!packet.key || packet.sourceEnd !== null) continue;
      const start = safeOffset(packet.offset);
      const length = Math.min(packet.byteLength, 4096);
      const prefix = new Uint8Array(
        await readOwnedRange(this.source, start, start + length, signal)
      );
      this.rangeReads++;
      this.sourceReadBytes += prefix.byteLength;
      signal?.throwIfAborted();
      if (!this.active || prefix.byteLength !== length)
        throw new Error('Owned demux VP9 prefix read invalidated');
      const destination = this.wasm.demux_input_ptr();
      if (destination <= 0 || destination + length > this.wasm.memory.buffer.byteLength)
        throw new Error('Owned demux VP9 prefix destination invalid');
      new Uint8Array(this.wasm.memory.buffer, destination, length).set(prefix);
      this.inputCopiedToWasmBytes += length;
      const status = this.wasm.demux_probe_vp9(length);
      if (status === 1) return;
      if (status === 3) continue;
      if (status === 2) throw new Error('Owned demux VP9 profile unsupported');
      if (status === 4) throw new Error('Owned demux VP9 resource limit exceeded');
      if (status === 5) throw new Error('Owned demux VP9 value overflow');
      throw new Error('Owned demux VP9 probe state invalid');
    }
    throw new Error('Owned demux VP9 key configuration unavailable');
  }

  /** Choose a verified random-access packet at or before the requested presentation time. */
  async findVerifiedKey(seconds: number, signal?: AbortSignal): Promise<number | null> {
    if (
      !this.active ||
      !this.ready ||
      this.seeking ||
      this.packetReadInProgress ||
      this.packetQueryInProgress ||
      this.snapshotOperation ||
      !Number.isFinite(seconds) ||
      seconds < 0
    )
      throw new Error('Owned demux seek request invalid');
    this.seeking = true;
    try {
      // Reuse the analyzed track's description during seek; a third JS copy
      // would escape the two-copy descriptor reservation in the caller.
      const track = this.analyzedTrack ?? this.track();
      const scaled = seconds * track.timescale;
      if (!Number.isFinite(scaled) || Math.abs(scaled) > Number.MAX_SAFE_INTEGER)
        throw new Error('Owned demux seek timestamp out of range');
      // Match the oracle's roundIfAlmostInteger conversion. Ordinary fractional
      // ticks remain fractional, so a request just before a key excludes it.
      const rounded = Math.round(scaled);
      const target = Math.abs(scaled / rounded - 1) < 10 * Number.EPSILON ? rounded : scaled;
      if (this.indexInfo?.mode === 'compact')
        return await this.findCompactVerifiedKey(track, BigInt(Math.floor(target)), signal);
      // The descriptor scan counted every key hint, including unverified ones.
      const keyCapacity = this.seekWorkspaceBytes / SEEK_KEY_BYTES;
      const indices = new Uint32Array(keyCapacity);
      const presentationTicks = new Float64Array(keyCapacity);
      let count = 0;
      const higher = (a: number, b: number): boolean =>
        presentationTicks[a]! > presentationTicks[b]! ||
        (presentationTicks[a] === presentationTicks[b] && indices[a]! > indices[b]!);
      const swap = (a: number, b: number): void => {
        const ticks = presentationTicks[a]!,
          index = indices[a]!;
        presentationTicks[a] = presentationTicks[b]!;
        indices[a] = indices[b]!;
        presentationTicks[b] = ticks;
        indices[b] = index;
      };
      for (let index = 0; index < track.packetCount; index++) {
        if (index % 256 === 0) {
          signal?.throwIfAborted();
          if (!this.active) throw new Error('Owned demux session released');
          await nextTask();
        }
        const packet = this.packet(index);
        const ticks = Number(packet.ptsTicks);
        if (!Number.isSafeInteger(ticks))
          throw new Error('Owned demux seek timestamp out of range');
        if (!packet.key || ticks > target) continue;
        if (count >= keyCapacity) throw new Error('Owned demux seek key count exceeded');
        let at = count++;
        // We scan in ascending index order, so this candidate wins equal-PTS ties.
        while (at > 0) {
          const parent = (at - 1) >> 1;
          if (ticks < presentationTicks[parent]!) break;
          presentationTicks[at] = presentationTicks[parent]!;
          indices[at] = indices[parent]!;
          at = parent;
        }
        presentationTicks[at] = ticks;
        indices[at] = index;
      }
      while (count > 0) {
        signal?.throwIfAborted();
        if (!this.active) throw new Error('Owned demux session released');
        const index = indices[0]!;
        const packet = this.packet(index);
        const payload = new Uint8Array(await this.readPacketInternal(packet, signal, true));
        if (await verifyOwnedVideoKey(track.codec, track.description, payload, signal)) {
          signal?.throwIfAborted();
          if (!this.active) throw new Error('Owned demux session released');
          return index;
        }
        count--;
        if (count > 0) {
          indices[0] = indices[count]!;
          presentationTicks[0] = presentationTicks[count]!;
          let at = 0;
          for (;;) {
            const left = at * 2 + 1,
              right = left + 1;
            if (left >= count) break;
            const child = right < count && higher(right, left) ? right : left;
            if (!higher(child, at)) break;
            swap(child, at);
            at = child;
          }
        }
        await nextTask();
      }
      return null;
    } catch (error) {
      this.evictPacketWindow();
      throw error;
    } finally {
      this.seeking = false;
    }
  }

  private async findCompactVerifiedKey(
    track: OwnedDemuxTrack,
    targetTicks: bigint,
    signal?: AbortSignal
  ): Promise<number | null> {
    signal?.throwIfAborted();
    const ticks = BigInt.asUintN(64, targetTicks);
    if (
      this.wasm.demux_seek_begin(
        Number(ticks & 0xffff_ffffn),
        Number(ticks >> 32n),
        0xffff_ffff
      ) !== 1
    )
      throw new Error('Owned demux compact seek start state invalid');
    try {
      if (this.wasm.memory.buffer.byteLength > MAX_WASM_CAPACITY_BYTES)
        throw new Error('Owned demux WASM capacity limit exceeded');
      for (let steps = 0; steps < MAX_STEPS + track.packetCount; steps++) {
        signal?.throwIfAborted();
        if (!this.active) throw new Error('Owned demux session released');
        const event = eventView(this.wasm, this.wasm.demux_seek_step(64));
        if (event.getUint32(0, true) !== 10)
          throw new Error('Owned demux compact seek ABI event invalid');
        const state = event.getUint32(4, true);
        if (state === 1) {
          await nextTask();
          continue;
        }
        if (state === 3) return null;
        if (state === 4)
          throw new Error(`Owned demux compact seek error ${event.getUint32(8, true)}`);
        if (state !== 2) throw new Error('Owned demux compact seek ABI state invalid');
        const index = event.getUint32(8, true);
        if (index >= track.packetCount)
          throw new Error('Owned demux compact seek candidate invalid');
        const packet = await this.queryPacketRecord(index, signal);
        if (!packet.key || packet.ptsTicks > targetTicks)
          throw new Error('Owned demux compact seek candidate invalid');
        const payload = new Uint8Array(await this.readPacketInternal(packet, signal, true));
        if (await verifyOwnedVideoKey(track.codec, track.description, payload, signal)) {
          signal?.throwIfAborted();
          if (!this.active) throw new Error('Owned demux session released');
          return index;
        }
        await nextTask();
      }
      throw new Error('Owned demux compact seek logical work limit exceeded');
    } finally {
      if (this.active && this.wasm.demux_seek_end() !== 1)
        throw new Error('Owned demux compact seek cleanup failed');
    }
  }

  release(): void {
    if (!this.active) return;
    this.evictPacketWindow();
    this.packetWindowEnabled = false;
    this.active = false;
    this.ready = false;
    this.analyzedTrack = null;
    this.indexInfo = null;
    this.lastNativePacket = null;
    this.generation++;
    this.wasm.demux_release();
  }
}
