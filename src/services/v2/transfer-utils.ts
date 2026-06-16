/** ArrayBuffer를 postMessage transferList로 전송 — 복사 대신 소유권 이전 */
export function transferBuffer(
  buffer: ArrayBuffer,
  transfer: Transferable[] = []
): [ArrayBuffer, Transferable[]] {
  transfer.push(buffer);
  return [buffer, transfer];
}

/** VideoFrame 자동 close 보장 래퍼 */
export class AutoFrame implements Disposable {
  constructor(public frame: VideoFrame) {}
  close(): void {
    this.frame.close();
  }
  [Symbol.dispose](): void {
    this.close();
  }
}

/** VideoFrame → ImageBitmap 변환 */
export async function frameToImageBitmap(frame: VideoFrame): Promise<ImageBitmap> {
  return createImageBitmap(frame, {
    resizeWidth: frame.displayWidth,
    resizeHeight: frame.displayHeight,
  });
}
