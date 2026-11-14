// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Host-owned Blob range reads for the bounded, conversion-owned Rust demux parser. */

const ABI_VERSION = 1;
const MAX_INPUT_BYTES = 500 * 1024 * 1024;
const MAX_PACKET_BYTES = 16 * 1024 * 1024 - 1024;
const EVENT_BYTES = 64;
const MAX_STEPS = 2_000_000;

type DemuxExports = {
  memory: WebAssembly.Memory;
  demux_abi_version(): number;
  demux_init(lo: number, hi: number): number;
  demux_input_ptr(): number;
  demux_step(credit: number): number;
  demux_feed(length: number): number;
  demux_track(): number;
  demux_description_ptr(): number;
  demux_packet_count(): number;
  demux_packet(index: number): number;
  demux_release(): void;
};

export type OwnedDemuxTrack = {
  codec: string;
  width: number;
  height: number;
  timescale: number;
  durationTicks: bigint;
  rotation: number;
  description: Uint8Array;
  packetCount: number;
};

export type OwnedDemuxPacket = {
  offset: bigint;
  byteLength: number;
  dtsTicks: bigint;
  ptsTicks: bigint;
  durationTicks: number;
  key: boolean;
};

function eventView(wasm: DemuxExports, pointer: number): DataView {
  if (!Number.isInteger(pointer) || pointer <= 0 || pointer + EVENT_BYTES > wasm.memory.buffer.byteLength)
    throw new Error('Owned demux invalid ABI event pointer');
  return new DataView(wasm.memory.buffer, pointer, EVENT_BYTES);
}

function safeOffset(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Owned demux offset out of host range');
  return Number(value);
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export class OwnedDemuxSession {
  private readonly wasm: DemuxExports;
  private readonly source: Blob;
  private active = true;
  private ready = false;

  constructor(source: Blob, module: WebAssembly.Module) {
    if (source.size < 8 || source.size > MAX_INPUT_BYTES)
      throw new Error('Owned demux input size limit exceeded');
    const instance = new WebAssembly.Instance(module, {});
    this.wasm = instance.exports as unknown as DemuxExports;
    if (this.wasm.demux_abi_version() !== ABI_VERSION)
      throw new Error('Owned demux ABI version mismatch');
    this.source = source;
    const size = BigInt(source.size);
    const pointer = this.wasm.demux_init(Number(size & 0xffff_ffffn), Number(size >> 32n));
    if (!pointer) throw new Error('Owned demux initialization failed');
    eventView(this.wasm, pointer);
  }

  async analyze(signal?: AbortSignal): Promise<OwnedDemuxTrack> {
    if (!this.active || this.ready) throw new Error('Owned demux session state invalid');
    try {
      for (let steps = 0; steps < MAX_STEPS; steps++) {
        signal?.throwIfAborted();
        const event = eventView(this.wasm, this.wasm.demux_step(64));
        const status = event.getUint32(0, true);
        if (status === 1) {
          const offset = event.getBigUint64(8, true);
          const length = event.getUint32(16, true);
          const start = safeOffset(offset);
          if (length < 1 || length > 64 * 1024 || start + length > this.source.size)
            throw new Error('Owned demux invalid input request');
          const window = new Uint8Array(await this.source.slice(start, start + length).arrayBuffer());
          signal?.throwIfAborted();
          if (window.length !== length) throw new Error('Owned demux truncated read');
          const destination = this.wasm.demux_input_ptr();
          if (destination <= 0 || destination + length > this.wasm.memory.buffer.byteLength)
            throw new Error('Owned demux invalid input destination');
          // No WASM call or growth occurs while the host writes this leased destination.
          new Uint8Array(this.wasm.memory.buffer, destination, length).set(window);
          if (!this.wasm.demux_feed(length)) throw new Error('Owned demux input feed failed');
        } else if (status === 2) {
          await nextTask();
        } else if (status === 3) {
          this.ready = true;
          return this.track();
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
    }
  }

  track(): OwnedDemuxTrack {
    if (!this.active || !this.ready) throw new Error('Owned demux track unavailable');
    const view = eventView(this.wasm, this.wasm.demux_track());
    if (view.getUint32(0, true) !== 6) throw new Error('Owned demux invalid track event');
    const codec = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + 8, 4));
    const width = view.getUint32(12, true);
    const height = view.getUint32(16, true);
    const timescale = view.getUint32(20, true);
    const durationTicks = view.getBigUint64(24, true);
    const rotation = view.getUint32(32, true);
    const descriptionLength = view.getUint32(36, true);
    const pointer = this.wasm.demux_description_ptr();
    if (descriptionLength > 1024 * 1024 || pointer <= 0 || pointer + descriptionLength > this.wasm.memory.buffer.byteLength)
      throw new Error('Owned demux description out of range');
    const description = new Uint8Array(this.wasm.memory.buffer, pointer, descriptionLength).slice();
    return { codec, width, height, timescale, durationTicks, rotation, description, packetCount: this.wasm.demux_packet_count() };
  }

  packet(index: number): OwnedDemuxPacket {
    if (!this.active || !this.ready || !Number.isSafeInteger(index) || index < 0)
      throw new Error('Owned demux packet index invalid');
    const view = eventView(this.wasm, this.wasm.demux_packet(index));
    if (view.getUint32(0, true) !== 5) throw new Error('Owned demux packet unavailable');
    const offset = view.getBigUint64(8, true);
    const byteLength = view.getUint32(16, true);
    if (byteLength < 1 || byteLength > MAX_PACKET_BYTES || safeOffset(offset) + byteLength > this.source.size)
      throw new Error('Owned demux packet range invalid');
    return {
      offset, byteLength,
      key: view.getUint32(20, true) === 1,
      dtsTicks: view.getBigInt64(24, true),
      ptsTicks: view.getBigInt64(32, true),
      durationTicks: view.getUint32(40, true),
    };
  }

  async readPacket(packet: OwnedDemuxPacket, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (!this.active || !this.ready) throw new Error('Owned demux session released');
    signal?.throwIfAborted();
    const start = safeOffset(packet.offset);
    if (packet.byteLength < 1 || packet.byteLength > MAX_PACKET_BYTES || start + packet.byteLength > this.source.size)
      throw new Error('Owned demux packet range invalid');
    const data = await this.source.slice(start, start + packet.byteLength).arrayBuffer();
    signal?.throwIfAborted();
    if (!this.active || data.byteLength !== packet.byteLength)
      throw new Error('Owned demux packet read invalidated');
    return data;
  }

  release(): void {
    if (!this.active) return;
    this.active = false;
    this.ready = false;
    this.wasm.demux_release();
  }
}
