export function createThrottledProgressReporter(params: {
  startPercent: number;
  endPercent: number;
  tickIntervalMs: number;
  initialStatusPrefix: string;
  throwIfCancelled: () => void;
  reportProgress: (percent: number) => void;
  reportStatus: (status: string) => void;
}): {
  report: (current: number, total: number) => void;
  setStatusPrefix: (prefix: string) => void;
  getLastPercent: () => number;
} {
  const {
    startPercent,
    endPercent,
    tickIntervalMs,
    initialStatusPrefix,
    throwIfCancelled,
    reportProgress,
    reportStatus,
  } = params;

  let statusPrefix = initialStatusPrefix;
  let lastStatusAt = 0;
  let lastStatusCurrent = -1;
  let lastProgressPercent = Math.round(startPercent);

  const setStatusPrefix = (prefix: string) => {
    statusPrefix = prefix;
    reportStatus(prefix);
  };

  const report = (current: number, total: number) => {
    throwIfCancelled();

    const safeTotal = Math.max(1, total);
    const safeCurrent = Math.min(Math.max(0, current), safeTotal);
    const progress = startPercent + ((endPercent - startPercent) * safeCurrent) / safeTotal;
    const rounded = Math.round(progress);

    // Avoid redundant UI updates when the rounded percent does not change.
    // (Encoders may report progress very frequently; rounding can collapse many updates.)
    if (rounded !== lastProgressPercent) {
      lastProgressPercent = rounded;
      reportProgress(rounded);
    }

    const now = Date.now();
    const isTerminal = safeCurrent >= safeTotal;

    // Status strings are user-visible. In addition to time-based throttling,
    // allow immediate updates when progress jumps significantly (e.g., chunked
    // encoders) so the UI does not appear stale.
    const deltaThreshold = Math.max(1, Math.ceil(safeTotal / 20));
    const shouldUpdateStatus =
      safeCurrent !== lastStatusCurrent &&
      (isTerminal ||
        now - lastStatusAt >= tickIntervalMs ||
        (lastStatusCurrent >= 0 && safeCurrent - lastStatusCurrent >= deltaThreshold));

    if (shouldUpdateStatus) {
      lastStatusAt = now;
      lastStatusCurrent = safeCurrent;
      reportStatus(`${statusPrefix} (${safeCurrent}/${safeTotal})`);
    }
  };

  const getLastPercent = () => lastProgressPercent;

  return { report, setStatusPrefix, getLastPercent };
}
