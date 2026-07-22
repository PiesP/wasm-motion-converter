import { globalBufferPool } from './buffer-pool';

/**
 * Run an operation while owning a pooled RGB buffer.
 *
 * Decoder callbacks transfer ownership of their buffer to the consumer. The
 * buffer must therefore be returned for every completion mode, including
 * codec, parser, and muxer failures.
 */
export async function withPooledBuffer<T>(
  buffer: Uint8Array,
  operation: () => T | Promise<T>
): Promise<T> {
  try {
    return await operation();
  } finally {
    globalBufferPool.release(buffer);
  }
}
