type ProgressReporterParams = {
  startPercent: number;
  endPercent: number;
  tickIntervalMs: number;
  initialStatusPrefix: string;
  throwIfCancelled: () => void;
  reportProgress: (percent: number) => void;
  reportStatus: (status: string) => void;
};

type ProgressReporter = {
  report: (current: number, total: number) => void;
  setStatusPrefix: (prefix: string) => void;
  getLastPercent: () => number;
};

type ProgressSnapshot = {
  safeCurrent: number;
  safeTotal: number;
  roundedPercent: number;
  isTerminal: boolean;
};

const clampNumber = (value: number, minValue: number, maxValue: number): number =>
  Math.min(Math.max(value, minValue), maxValue);

const resolveDeltaThreshold = (total: number): number => Math.max(1, Math.ceil(total / 20));

const createSnapshot = (
  current: number,
  total: number,
  startPercent: number,
  endPercent: number
): ProgressSnapshot => {
  const safeTotal = Math.max(1, total);
  const safeCurrent = clampNumber(current, 0, safeTotal);
  const progress = startPercent + ((endPercent - startPercent) * safeCurrent) / safeTotal;
  const roundedPercent = Math.round(progress);

  return {
    safeCurrent,
    safeTotal,
    roundedPercent,
    isTerminal: safeCurrent >= safeTotal,
  };
};

export function createThrottledProgressReporter(params: ProgressReporterParams): ProgressReporter {
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

    const snapshot = createSnapshot(current, total, startPercent, endPercent);

    if (snapshot.roundedPercent !== lastProgressPercent) {
      lastProgressPercent = snapshot.roundedPercent;
      reportProgress(snapshot.roundedPercent);
    }

    const now = Date.now();
    const deltaThreshold = resolveDeltaThreshold(snapshot.safeTotal);
    const shouldUpdateStatus =
      snapshot.safeCurrent !== lastStatusCurrent &&
      (snapshot.isTerminal ||
        now - lastStatusAt >= tickIntervalMs ||
        (lastStatusCurrent >= 0 && snapshot.safeCurrent - lastStatusCurrent >= deltaThreshold));

    if (shouldUpdateStatus) {
      lastStatusAt = now;
      lastStatusCurrent = snapshot.safeCurrent;
      reportStatus(`${statusPrefix} (${snapshot.safeCurrent}/${snapshot.safeTotal})`);
    }
  };

  const getLastPercent = () => lastProgressPercent;

  return { report, setStatusPrefix, getLastPercent };
}
