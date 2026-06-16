/** 고정 크기 프레임 버퍼 풀 — 메모리 상한 제한 */
export class FrameRingBuffer {
  private buffer: (VideoFrame | null)[];
  private writeIdx = 0;
  private readIdx = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity).fill(null);
  }

  push(frame: VideoFrame): void {
    if (this.count === this.capacity) {
      this.buffer[this.readIdx]?.close();
      this.readIdx = (this.readIdx + 1) % this.capacity;
    } else {
      this.count++;
    }
    this.buffer[this.writeIdx]?.close();
    this.buffer[this.writeIdx] = frame;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
  }

  shift(): VideoFrame | null {
    if (this.count === 0) return null;
    const frame = this.buffer[this.readIdx] ?? null;
    this.buffer[this.readIdx] = null;
    this.readIdx = (this.readIdx + 1) % this.capacity;
    this.count--;
    return frame;
  }

  clear(): void {
    for (const frame of this.buffer) frame?.close();
    this.buffer.fill(null);
    this.count = 0;
    this.writeIdx = 0;
    this.readIdx = 0;
  }

  get size(): number { return this.count; }
  get isFull(): boolean { return this.count === this.capacity; }
  get isEmpty(): boolean { return this.count === 0; }
}
