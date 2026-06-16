/**
 * 크로스 브라우저 메모리 추정 가드
 *
 * Chrome: performance.memory 사용
 * Firefox/Safari: navigator.deviceMemory + 휴리스틱
 */
export class MemoryGuard {
  private maxMemoryMB: number;

  constructor(maxMemoryMB: number) {
    this.maxMemoryMB = maxMemoryMB;
  }

  /** 현재 사용 가능한 메모리 추정 (MB), maxMemoryMB 이하로 제한 */
  get availableMB(): number {
    let estimated: number;

    if ('memory' in performance) {
      const mem = (performance as any).memory;
      const used = mem.usedJSHeapSize / (1024 * 1024);
      const limit = mem.jsHeapSizeLimit / (1024 * 1024);
      estimated = Math.max(0, limit - used);
    } else {
      const deviceMemGB = (navigator as any).deviceMemory ?? 4;
      estimated = deviceMemGB * 1024 * 0.5;
    }

    return Math.min(estimated, this.maxMemoryMB);
  }

  /** 주어진 해상도+프레임 수가 메모리 한도를 초과하는지 검사 */
  canFit(width: number, height: number, frameCount: number): boolean {
    const bytesPerFrame = width * height * 4;
    const totalMB = (bytesPerFrame * frameCount) / (1024 * 1024);
    const headroom = this.availableMB * 0.7;
    return totalMB < headroom;
  }

  /** 초과 시 권장 스케일 계산 */
  suggestScale(width: number, height: number, frameCount: number): number {
    if (this.canFit(width, height, frameCount)) return 1.0;
    const targetMB = this.availableMB * 0.6;
    const bytesPerFrame = width * height * 4;
    const targetBytes = bytesPerFrame * frameCount;
    const rawScale = Math.sqrt(targetMB * 1024 * 1024 / targetBytes);
    return Math.max(0.1, Math.min(1.0, rawScale));
  }
}
