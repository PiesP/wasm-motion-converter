type PerformancePhase =
  | 'ffmpeg-download'
  | 'ffmpeg-init'
  | 'conversion'
  | 'palette-gen'
  | 'webp-encode';

interface TimingEntry {
  phase: PerformancePhase;
  startTime: number;
  endTime?: number;
  duration?: number;
  metadata?: Record<string, unknown>;
}

class PerformanceTracker {
  private timings: TimingEntry[] = [];

  startPhase(phase: PerformancePhase, metadata?: Record<string, unknown>): void {
    this.timings.push({
      phase,
      startTime: performance.now(),
      metadata,
    });
  }

  endPhase(phase: PerformancePhase): void {
    const entry = this.timings.find((t) => t.phase === phase && !t.endTime);
    if (entry) {
      entry.endTime = performance.now();
      entry.duration = entry.endTime - entry.startTime;
    }
  }

  getReport(): Record<string, unknown> {
    return {
      timings: this.timings,
      summary: this.timings.reduce(
        (acc, t) => {
          if (t.duration) {
            acc[t.phase] = t.duration;
          }
          return acc;
        },
        {} as Record<string, number>
      ),
      totalTime: this.timings.reduce((sum, t) => sum + (t.duration || 0), 0),
    };
  }

  exportToConsole(): void {
    console.table(this.getReport().summary);
  }

  saveToSessionStorage(): void {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('perf-report', JSON.stringify(this.getReport()));
    }
  }

  reset(): void {
    this.timings = [];
  }
}

export const performanceTracker = new PerformanceTracker();
