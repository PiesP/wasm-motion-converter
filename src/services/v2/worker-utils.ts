/** Worker 생성 + OffscreenCanvas 전송 */
export function createConversionWorker(
  canvas: HTMLCanvasElement
): { worker: Worker; offscreen: OffscreenCanvas } {
  const offscreen = canvas.transferControlToOffscreen();
  const worker = new Worker(
    new URL('../../workers/conversion.worker.ts', import.meta.url),
    { type: 'module' }
  );
  worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
  return { worker, offscreen };
}
