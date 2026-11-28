// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  BYTES_PER_MB,
  GIF_MAX_FRAME_DELAY_CS,
  GIF_MAX_OUTPUT_BYTES,
  GIF_MAX_OUTPUT_FRAMES,
  GIF_MIN_FRAME_DELAY_MS,
} from '@utils/constants';
import { logger } from '@utils/logger';

import type { GifOutputPart } from './gif-encoder-service';
import { acquireGifOutputLease } from './gif-output-lease';
import { GifStagedOutputLimitError } from './gif-staged-output-limit-error';

const WRITE_BYTES = BYTES_PER_MB;
const MAX_STAGED_MIB = 512;
const MAX_STAGED_BYTES = MAX_STAGED_MIB * BYTES_PER_MB;
const OWNED_FILE =
  /^dropconvert-gif-opfs-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.gif$/;
const MAGIC = new TextEncoder().encode('GIF89a');
const LOOP_START = Uint8Array.of(0x21, 0xff, 11, ...new TextEncoder().encode('NETSCAPE2.0'), 3, 1);
const TRAILER = Uint8Array.of(0x3b);

type GifBytes = Uint8Array<ArrayBuffer>;
interface GifHeader {
  canvas: GifBytes;
  palette: GifBytes;
  loop: GifBytes;
}

function sameBytes(a: GifBytes, b: GifBytes): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function inspectPart(part: GifOutputPart, reference?: GifHeader) {
  const bytes = new Uint8Array(part.bytes);
  let cursor = 0;
  function take(length: number): GifBytes {
    const start = cursor;
    cursor += length;
    if (cursor > bytes.length) throw new Error('Truncated GIF part');
    return bytes.subarray(start, cursor);
  }

  const screen = take(13);
  const screenFlags = screen[10]!;
  const canvas = screen.subarray(6, 10);
  if (
    !sameBytes(screen.subarray(0, 6), MAGIC) ||
    (screenFlags & 0x88) !== 0x80 ||
    (!canvas[0] && !canvas[1]) ||
    (!canvas[2] && !canvas[3]) ||
    screen[11] !== 0 ||
    screen[12] !== 0
  ) {
    throw new Error('Invalid GIF part screen descriptor');
  }
  const paletteCode = screenFlags & 7;
  const palette = take(3 << (paletteCode + 1));
  const loop = take(bytes[cursor] === 0x21 && bytes[cursor + 1] === 0xff ? 19 : 0);
  if (loop.length && (!sameBytes(loop.subarray(0, 16), LOOP_START) || loop[18] !== 0)) {
    throw new Error('Invalid GIF part loop extension');
  }
  if (reference && (!sameBytes(canvas, reference.canvas) || !sameBytes(loop, reference.loop))) {
    throw new Error('Incompatible GIF part canvas or loop');
  }

  const recordsStart = cursor;
  const needsLocalPalette = reference !== undefined && !sameBytes(palette, reference.palette);
  const repairs: number[] = [];
  let frameCount = 0;
  let durationCs = 0;
  while (bytes[cursor] !== TRAILER[0]) {
    const control = take(8);
    const delay = control[4]! + control[5]! * 256;
    if (
      control[0] !== 0x21 ||
      control[1] !== 0xf9 ||
      control[2] !== 4 ||
      control[3] !== 0 ||
      control[6] !== 0 ||
      control[7] !== 0 ||
      delay < GIF_MIN_FRAME_DELAY_MS / 10 ||
      delay > GIF_MAX_FRAME_DELAY_CS
    ) {
      throw new Error('Invalid opaque GIF graphic control');
    }
    const image = take(10);
    const imageFlags = image[9]!;
    if (
      image[0] !== 0x2c ||
      image.subarray(1, 5).some(Boolean) ||
      !sameBytes(image.subarray(5, 9), canvas) ||
      (imageFlags !== 0 && (imageFlags < 0x80 || imageFlags > 0x87))
    ) {
      throw new Error('Invalid full-canvas GIF image descriptor');
    }
    if (imageFlags & 0x80) take(3 << ((imageFlags & 7) + 1));
    else if (needsLocalPalette) repairs.push(cursor - 1);

    const minimumCodeSize = bytes[cursor++];
    if (
      minimumCodeSize === undefined ||
      minimumCodeSize < 2 ||
      minimumCodeSize > 8 ||
      !bytes[cursor]
    ) {
      throw new Error('Invalid GIF LZW image data');
    }
    // Walk sub-block lengths without copying compressed bytes or allocating a view per block.
    for (;;) {
      const size = bytes[cursor++];
      if (size === undefined || cursor + size > bytes.length)
        throw new Error('Truncated GIF LZW sub-block');
      if (size === 0) break;
      cursor += size;
    }
    frameCount++;
    durationCs += delay;
    if (frameCount > part.frameCount) throw new Error('Unexpected GIF part frame count');
  }
  const end = cursor;
  if (
    end !== bytes.length - 1 ||
    frameCount !== part.frameCount ||
    durationCs !== part.endCs - part.startCs
  ) {
    throw new Error('GIF part trailer or timeline does not match the Worker offer');
  }
  return { bytes, recordsStart, end, canvas, palette, paletteCode, loop, repairs };
}

async function removeFile(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
  }
}

async function reclaimAbandonedFiles(directory: FileSystemDirectoryHandle): Promise<void> {
  try {
    for await (const entry of directory.values()) {
      const { name } = entry;
      if (entry.kind !== 'file' || !OWNED_FILE.test(name)) continue;
      try {
        await navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
          if (lock) await removeFile(directory, name);
        });
      } catch {
        logger.warn('conversion', 'Unable to remove abandoned continuous GIF output');
      }
    }
  } catch {
    logger.warn('conversion', 'Unable to inspect abandoned continuous GIF output');
  }
}

export type GifPartOpfsSink = Awaited<ReturnType<typeof createGifPartOpfsSink>>;

/** Experimental single-file output that owns each transferred part only until its writes settle. */
export async function createGifPartOpfsSink() {
  const directory = await navigator.storage.getDirectory();
  await reclaimAbandonedFiles(directory);
  const name = `dropconvert-gif-opfs-${crypto.randomUUID()}.gif`;
  const releaseLease = await acquireGifOutputLease(name);
  let handle: FileSystemFileHandle;
  let stream: FileSystemWritableFileStream | undefined;
  try {
    handle = await directory.getFileHandle(name, { create: true });
    stream = await handle.createWritable();
  } catch (cause) {
    const errors = [cause];
    try {
      await removeFile(directory, name);
    } catch (error) {
      errors.push(error);
    }
    try {
      await releaseLease();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 1) throw new AggregateError(errors, 'Unable to prepare staged GIF output');
    throw cause;
  }

  const lifetime = new AbortController();
  let reference: GifHeader | undefined;
  let count = 0;
  let endCs = 0;
  let outputBytes = 0;
  let published = false;
  let active: Promise<void> | undefined;
  let deletion: Promise<void> | undefined;

  async function write(bytes: GifBytes, signal: AbortSignal): Promise<void> {
    const writer = stream;
    if (!writer) throw new Error('Staged GIF output is closed');
    for (let offset = 0; offset < bytes.length; offset += WRITE_BYTES) {
      signal.throwIfAborted();
      const chunk = bytes.subarray(offset, offset + WRITE_BYTES);
      await writer.write(chunk);
      outputBytes += chunk.length;
      signal.throwIfAborted();
    }
  }

  function dispose(): Promise<void> {
    if (deletion) return deletion;
    lifetime.abort();
    published = false;
    deletion = (async () => {
      await active?.catch(() => undefined);
      window.removeEventListener('pagehide', onPageHide);
      const errors: unknown[] = [];
      if (stream) {
        try {
          await stream.abort();
        } catch (error) {
          errors.push(error);
        }
        stream = undefined;
      }
      try {
        await removeFile(directory, name);
      } catch (error) {
        errors.push(error);
      }
      try {
        await releaseLease();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, 'Unable to remove staged GIF output');
    })().catch((error: unknown) => {
      deletion = undefined;
      throw error;
    });
    return deletion;
  }

  function onPageHide(event: PageTransitionEvent): void {
    if (!event.persisted) void dispose().catch(() => undefined);
  }

  async function run(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<void>
  ): Promise<void> {
    if (active) throw new Error('A staged GIF operation is already active');
    const operationSignal = AbortSignal.any([lifetime.signal, signal]);
    const pending = Promise.resolve().then(async () => {
      operationSignal.throwIfAborted();
      await operation(operationSignal);
    });
    active = pending;
    try {
      await pending;
    } catch (cause) {
      try {
        await dispose();
      } catch (cleanupError) {
        throw new AggregateError([cause, cleanupError], 'Unable to discard incomplete GIF output');
      }
      throw cause;
    } finally {
      active = undefined;
    }
  }

  window.addEventListener('pagehide', onPageHide);
  return {
    filename: 'continuous.gif',
    get count() {
      return count;
    },
    get ready() {
      return published;
    },
    save(part: GifOutputPart, signal: AbortSignal): Promise<void> {
      if (published) return Promise.reject(new Error('Staged GIF output is already closed'));
      return run(signal, async (operationSignal) => {
        if (
          part.index !== count + 1 ||
          count >= GIF_MAX_OUTPUT_FRAMES ||
          part.startCs !== endCs ||
          !Number.isSafeInteger(part.endCs) ||
          part.endCs <= part.startCs ||
          !Number.isSafeInteger(part.frameCount) ||
          part.frameCount < 1 ||
          part.frameCount > GIF_MAX_OUTPUT_FRAMES ||
          part.bytes.byteLength > GIF_MAX_OUTPUT_BYTES
        ) {
          throw new Error('Invalid GIF part offer');
        }
        const partData = inspectPart(part, reference);
        let cursor = reference ? partData.recordsStart : 0;
        const newBytes = partData.end - cursor + partData.repairs.length * partData.palette.length;
        if (newBytes >= MAX_STAGED_BYTES - outputBytes) {
          throw new GifStagedOutputLimitError(MAX_STAGED_MIB);
        }

        // Reuse one palette-sized patch. All unchanged bytes go directly from the offered
        // buffer to the writer; only the first canvas/loop/table remain after acknowledgement.
        if (partData.repairs.length) {
          const patch = Uint8Array.of(0x80 | partData.paletteCode, ...partData.palette);
          for (const position of partData.repairs) {
            await write(partData.bytes.subarray(cursor, position), operationSignal);
            await write(patch, operationSignal);
            cursor = position + 1;
          }
        }
        await write(partData.bytes.subarray(cursor, partData.end), operationSignal);
        reference ??= {
          canvas: partData.canvas.slice(),
          palette: partData.palette.slice(),
          loop: partData.loop.slice(),
        };
        count++;
        endCs = part.endCs;
      });
    },
    finish(signal: AbortSignal): Promise<void> {
      return run(signal, async (operationSignal) => {
        if (published) return;
        if (!count || !stream) throw new Error('Conversion produced no GIF parts');
        await write(TRAILER, operationSignal);
        await stream.close();
        stream = undefined;
        operationSignal.throwIfAborted();
        const file = await handle.getFile();
        operationSignal.throwIfAborted();
        if (file.size !== outputBytes) throw new Error('Staged GIF output is incomplete');
        published = true;
      });
    },
    async read(signal: AbortSignal): Promise<File> {
      const operationSignal = AbortSignal.any([lifetime.signal, signal]);
      operationSignal.throwIfAborted();
      if (!published) throw new Error('Staged GIF output is unavailable');
      const file = await handle.getFile();
      operationSignal.throwIfAborted();
      if (file.size !== outputBytes) throw new Error('Staged GIF output is incomplete');
      return file;
    },
    dispose,
  };
}
