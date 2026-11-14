// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Host-owned Blob range reads for the bounded, conversion-owned Rust demux parser. */

import { schedulerYield as yieldToMain } from '@piesp/browser-core/util';

import { ownedReadCreditStats, readOwnedRange } from './owned-demux-source-reads';

const ABI_VERSION = 2;
const MAX_INPUT_BYTES = 500 * 1024 * 1024;
const MAX_PACKET_BYTES = 16 * 1024 * 1024 - 1024;
const MAX_WASM_CAPACITY_BYTES = 64 * 1024 * 1024;
const MAX_TRACK_PACKETS = Math.floor((32 * 1024 * 1024) / 48);
const EVENT_BYTES = 64;
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
  demux_packet_begin(index: number): number;
  demux_prepare_packets(maxPacket: number): number;
  demux_probe_vp9(prefixLength: number): number;
  demux_packet_feed(length: number): number;
  demux_packet_finish(): number;
  demux_release(): void;
};

type RangeSource = {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
};

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
  packetReadBytes: number;
  stepCalls: number;
  wasmCapacityBytes: number;
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

async function nextTask(): Promise<void> {
  await yieldToMain();
}

export class OwnedDemuxSession {
  private readonly wasm: DemuxExports;
  private readonly source: RangeSource;
  private active = true;
  private ready = false;
  private analyzing = false;
  private packetReadInProgress = false;
  private seeking = false;
  private generation = 1;
  private readonly sessionId = nextSessionId++;
  private rangeReads = 0;
  private sourceReadBytes = 0;
  private inputCopiedToWasmBytes = 0;
  private packetReadBytes = 0;
  private stepCalls = 0;
  private maxPacketBytes = 0;
  private preparedWasmCapacityBytes = 0;

  get transferStats(): OwnedDemuxTransferStats {
    const readCredit = ownedReadCreditStats();
    return {
      rangeReads: this.rangeReads,
      sourceReadBytes: this.sourceReadBytes,
      inputCopiedToWasmBytes: this.inputCopiedToWasmBytes,
      packetReadBytes: this.packetReadBytes,
      stepCalls: this.stepCalls,
      wasmCapacityBytes: this.wasm.memory.buffer.byteLength,
      maxPacketBytes: this.maxPacketBytes,
      realmReadLiveBytes: readCredit.liveBytes,
      realmReadRetiredBytes: readCredit.retiredBytes,
    };
  }

  constructor(source: Blob | ArrayBuffer, module: WebAssembly.Module) {
    const rangeSource: RangeSource =
      source instanceof Blob
        ? source
        : {
            size: source.byteLength,
            slice: (start, end) => ({ arrayBuffer: async () => source.slice(start, end) }),
          };
    if (rangeSource.size < 8 || rangeSource.size > MAX_INPUT_BYTES)
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
          'demux_prepare_packets',
          'demux_probe_vp9',
          'demux_packet_begin',
          'demux_packet_feed',
          'demux_packet_finish',
          'demux_release',
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
    if (!this.active || this.ready || this.analyzing)
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
          let reconstructs = false;
          for (let index = 0; index < track.packetCount; index++) {
            if (index % 256 === 0) {
              signal?.throwIfAborted();
              if (!this.active) throw new Error('Owned demux session released');
              await nextTask();
            }
            const packet = this.readPacketRecord(index);
            this.maxPacketBytes = Math.max(this.maxPacketBytes, packet.byteLength);
            reconstructs ||= packet.sourceEnd !== null;
          }
          if (track.codec === 'VP90') {
            await this.probeVp9(signal);
            track = this.readTrackRecord();
          }
          if (reconstructs && !this.wasm.demux_prepare_packets(this.maxPacketBytes))
            throw new Error('Owned demux packet workspace admission failed');
          this.preparedWasmCapacityBytes = this.wasm.memory.buffer.byteLength;
          track.maxPacketBytes = this.maxPacketBytes;
          this.ready = true;
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
    if (!this.active || !this.ready || !Number.isSafeInteger(index) || index < 0)
      throw new Error('Owned demux packet index invalid');
    return this.readPacketRecord(index);
  }

  private readPacketRecord(index: number): OwnedDemuxPacket {
    const view = eventView(this.wasm, this.wasm.demux_packet(index));
    if (view.getUint32(0, true) !== 5) throw new Error('Owned demux packet unavailable');
    const offset = view.getBigUint64(8, true);
    const byteLength = view.getUint32(16, true);
    const sourceEnd = view.getBigUint64(48, true);
    if (
      byteLength < 1 ||
      byteLength > MAX_PACKET_BYTES ||
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
      key: view.getUint32(20, true) === 1,
      dtsTicks: view.getBigInt64(24, true),
      ptsTicks: view.getBigInt64(32, true),
      durationTicks: view.getBigUint64(40, true),
    };
  }

  async readPacket(packet: OwnedDemuxPacket, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (
      !this.active ||
      !this.ready ||
      packet.sessionId !== this.sessionId ||
      packet.generation !== this.generation ||
      this.packetReadInProgress
    )
      throw new Error('Owned demux packet lease invalid');
    signal?.throwIfAborted();
    this.packetReadInProgress = true;
    try {
      const current = this.packet(packet.index);
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
      if (packet.sourceEnd !== null) return await this.readTsPacket(packet, signal);
      const start = safeOffset(packet.offset);
      if (
        packet.byteLength < 1 ||
        packet.byteLength > MAX_PACKET_BYTES ||
        start + packet.byteLength > this.source.size
      )
        throw new Error('Owned demux packet range invalid');
      const data = await readOwnedRange(this.source, start, start + packet.byteLength, signal);
      this.rangeReads++;
      this.sourceReadBytes += data.byteLength;
      this.packetReadBytes += data.byteLength;
      signal?.throwIfAborted();
      if (!this.active || data.byteLength !== packet.byteLength)
        throw new Error('Owned demux packet read invalidated');
      return data;
    } finally {
      this.packetReadInProgress = false;
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
      const packet = this.readPacketRecord(index);
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
    if (!this.active || !this.ready || this.seeking || !Number.isFinite(seconds) || seconds < 0)
      throw new Error('Owned demux seek request invalid');
    this.seeking = true;
    try {
      const track = this.track();
      const scaled = seconds * track.timescale;
      if (!Number.isFinite(scaled) || Math.abs(scaled) > Number.MAX_SAFE_INTEGER)
        throw new Error('Owned demux seek timestamp out of range');
      // Match the oracle's roundIfAlmostInteger conversion. Ordinary fractional
      // ticks remain fractional, so a request just before a key excludes it.
      const rounded = Math.round(scaled);
      const target = Math.abs(scaled / rounded - 1) < 10 * Number.EPSILON ? rounded : scaled;
      const safeTick = BigInt(Number.MAX_SAFE_INTEGER);
      // The two typed arrays use at most 12 bytes per admitted indexed packet.
      // Heap insertion and removal are logarithmic; no whole-index sort occurs.
      const indices = new Uint32Array(track.packetCount);
      const points = new BigInt64Array(track.packetCount);
      let count = 0;
      const higher = (a: number, b: number): boolean =>
        points[a]! > points[b]! || (points[a] === points[b] && indices[a]! > indices[b]!);
      const swap = (a: number, b: number): void => {
        const point = points[a]!,
          index = indices[a]!;
        points[a] = points[b]!;
        indices[a] = indices[b]!;
        points[b] = point;
        indices[b] = index;
      };
      for (let index = 0; index < track.packetCount; index++) {
        if (index % 256 === 0) {
          signal?.throwIfAborted();
          if (!this.active) throw new Error('Owned demux session released');
          await nextTask();
        }
        const packet = this.packet(index);
        if (packet.ptsTicks < -safeTick || packet.ptsTicks > safeTick)
          throw new Error('Owned demux seek timestamp out of range');
        if (!packet.key || Number(packet.ptsTicks) > target) continue;
        let at = count++;
        points[at] = packet.ptsTicks;
        indices[at] = index;
        while (at > 0) {
          const parent = (at - 1) >> 1;
          if (!higher(at, parent)) break;
          swap(at, parent);
          at = parent;
        }
      }
      while (count > 0) {
        signal?.throwIfAborted();
        if (!this.active) throw new Error('Owned demux session released');
        const index = indices[0]!;
        count--;
        if (count > 0) {
          indices[0] = indices[count]!;
          points[0] = points[count]!;
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
        const packet = this.packet(index);
        const payload = new Uint8Array(await this.readPacket(packet, signal));
        if (await verifyOwnedVideoKey(track.codec, track.description, payload, signal))
          return index;
        await nextTask();
      }
      return null;
    } finally {
      this.seeking = false;
    }
  }

  release(): void {
    if (!this.active) return;
    this.active = false;
    this.ready = false;
    this.generation++;
    this.wasm.demux_release();
  }
}
