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
    const progress = startPercent + ((endPercent - startPercent) * current) / safeTotal;
    const rounded = Math.round(progress);

    // Avoid redundant UI updates when the rounded percent does not change.
    // (Encoders may report progress very frequently; rounding can collapse many updates.)
    if (rounded !== lastProgressPercent) {
      lastProgressPercent = rounded;
      reportProgress(rounded);
    }

    const now = Date.now();
    const isTerminal = current >= total;
    if (current !== lastStatusCurrent && (isTerminal || now - lastStatusAt >= tickIntervalMs)) {
      lastStatusAt = now;
      lastStatusCurrent = current;
      reportStatus(`${statusPrefix} (${current}/${safeTotal})`);
    }
  };

  const getLastPercent = () => lastProgressPercent;

  return { report, setStatusPrefix, getLastPercent };
}
