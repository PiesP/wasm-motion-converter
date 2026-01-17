import {
  type ConversionMatrixTestReport,
  runConversionMatrixTestWithReport,
} from '@services/dev/conversion-matrix-test-service';
import { appState, setAppState } from '@stores/app-store';
import { inputFile, videoMetadata } from '@stores/conversion-media-store';
import {
  conversionStatusMessage,
  setConversionProgress,
  setConversionStatusMessage,
} from '@stores/conversion-progress-store';
import { conversionSettings } from '@stores/conversion-settings-store';
import {
  devMatrixTestCancelRequested,
  resetDevMatrixTestCancel,
  setDevMatrixTestIsRunning,
} from '@stores/dev-matrix-test-store';
import {
  buildMatrixTestReportFilename,
  clearMatrixTestReports,
  deleteMatrixTestReport,
  downloadTextFile,
  listMatrixTestReports,
  loadMatrixTestReport,
  persistMatrixTestReport,
} from '@stores/matrix-test-report-store';
import { logger } from '@utils/logger';
import { type Component, createMemo, createSignal, type JSX, Show } from 'solid-js';

const DEFAULT_REPEAT_COUNT = 3;
const MIN_REPEAT_COUNT = 1;
const MAX_REPEAT_COUNT = 10;

interface DevConversionMatrixTestProps {
  disabled?: boolean;
}

const DevConversionMatrixTest: Component<DevConversionMatrixTestProps> = (props) => {
  const [isRunning, setIsRunning] = createSignal(false);
  const [repeats, setRepeats] = createSignal<number>(DEFAULT_REPEAT_COUNT);
  const [includeGif, setIncludeGif] = createSignal(true);
  const [includeWebp, setIncludeWebp] = createSignal(true);
  const [includeStrategyCodecScenarios, setIncludeStrategyCodecScenarios] = createSignal(false);
  const [autoDownloadReport, setAutoDownloadReport] = createSignal(true);
  const [reportsRefreshToken, setReportsRefreshToken] = createSignal(0);
  const [lastReportId, setLastReportId] = createSignal<string | null>(null);

  const canRun = createMemo(() => !!inputFile() && !props.disabled && !isRunning());

  const formatSummary = createMemo(() => {
    const formats: Array<'gif' | 'webp'> = [];
    if (includeGif()) {
      formats.push('gif');
    }
    if (includeWebp()) {
      formats.push('webp');
    }
    return formats;
  });

  const savedReports = createMemo(() => {
    reportsRefreshToken();
    return listMatrixTestReports();
  });

  const updateRepeats: JSX.EventHandlerUnion<HTMLInputElement, InputEvent> = (event) => {
    const nextValue = Number(event.currentTarget.value) || MIN_REPEAT_COUNT;
    const clampedValue = Math.max(MIN_REPEAT_COUNT, Math.min(MAX_REPEAT_COUNT, nextValue));
    setRepeats(clampedValue);
  };

  const handleRunClick = () => {
    void runMatrixTest();
  };

  const handleGifToggle: JSX.EventHandlerUnion<HTMLInputElement, Event> = (event) => {
    setIncludeGif(event.currentTarget.checked);
  };

  const handleWebpToggle: JSX.EventHandlerUnion<HTMLInputElement, Event> = (event) => {
    setIncludeWebp(event.currentTarget.checked);
  };

  const handleStrategyToggle: JSX.EventHandlerUnion<HTMLInputElement, Event> = (event) => {
    setIncludeStrategyCodecScenarios(event.currentTarget.checked);
  };

  const handleAutoDownloadToggle: JSX.EventHandlerUnion<HTMLInputElement, Event> = (event) => {
    setAutoDownloadReport(event.currentTarget.checked);
  };

  const handleClearReports = () => {
    clearMatrixTestReports();
    setReportsRefreshToken((value) => value + 1);
    setLastReportId(null);
  };

  const handleDeleteReport = (reportId: string) => {
    deleteMatrixTestReport(reportId);
    setReportsRefreshToken((value) => value + 1);
    if (lastReportId() === reportId) {
      setLastReportId(null);
    }
  };

  const handleDownloadLatest = () => {
    const id = lastReportId();
    if (!id) {
      return;
    }
    downloadReportById(id);
  };

  const downloadReportById = (id: string): void => {
    const report = loadMatrixTestReport<ConversionMatrixTestReport>(id);
    if (!report) {
      logger.warn('conversion', 'Matrix test report not found in storage', {
        id,
      });
      return;
    }

    const filename = buildMatrixTestReportFilename({
      startedAt: report.startedAt,
      fileName: report.file.name,
      reportId: report.reportId,
      format: 'json',
    });

    downloadTextFile({
      filename,
      text: JSON.stringify(report, null, 2),
      mimeType: 'application/json;charset=utf-8',
    });
  };

  const runMatrixTest = async (): Promise<void> => {
    const file = inputFile();
    if (!file) {
      return;
    }

    const formats = formatSummary();
    if (formats.length === 0) {
      return;
    }

    const previousAppState = appState();
    resetDevMatrixTestCancel();
    setDevMatrixTestIsRunning(true);
    setConversionProgress(0);
    setConversionStatusMessage('Preparing matrix test...');
    setAppState('converting');
    setIsRunning(true);

    try {
      const settings = conversionSettings();
      const report = await runConversionMatrixTestWithReport({
        file,
        metadata: videoMetadata(),
        formats,
        repeats: repeats(),
        quality: settings.quality,
        scale: settings.scale,
        includeStrategyCodecScenarios: includeStrategyCodecScenarios(),
        shouldCancel: () => devMatrixTestCancelRequested(),
        onProgress: (progress) => {
          setConversionProgress(Math.round(progress));
        },
        onStatusUpdate: (message) => {
          setConversionStatusMessage(message);
        },
      });

      const reportJson = JSON.stringify(report, null, 2);

      persistMatrixTestReport({
        reportId: report.reportId,
        createdAt: report.startedAt,
        fileName: report.file.name,
        totalRuns: report.summary.totalRuns,
        successCount: report.summary.successCount,
        errorCount: report.summary.errorCount,
        durationMs: report.summary.durationMs,
        reportJson,
      });

      setLastReportId(report.reportId);
      setReportsRefreshToken((value) => value + 1);

      const filename = buildMatrixTestReportFilename({
        startedAt: report.startedAt,
        fileName: report.file.name,
        reportId: report.reportId,
        format: 'json',
      });

      if (autoDownloadReport()) {
        downloadTextFile({
          filename,
          text: reportJson,
          mimeType: 'application/json;charset=utf-8',
        });
      }

      logger.info('conversion', 'Matrix test report saved (UI)', {
        reportId: report.reportId,
        filename,
        summary: report.summary,
      });
    } finally {
      setIsRunning(false);
      setDevMatrixTestIsRunning(false);
      resetDevMatrixTestCancel();
      setConversionProgress(0);
      setConversionStatusMessage('');
      setAppState(previousAppState);
    }
  };

  const isDisabled = () => props.disabled || isRunning();

  return (
    <Show when={import.meta.env.DEV}>
      <div class="mt-4 rounded-lg border border-dashed border-indigo-300 dark:border-indigo-700 bg-indigo-50/60 dark:bg-indigo-900/10 p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-sm font-semibold text-indigo-900 dark:text-indigo-200">
              Dev Conversion Matrix
            </div>
            <div class="mt-1 text-xs text-indigo-800/80 dark:text-indigo-200/80">
              Runs a conversion matrix (multiple path combinations) against the currently selected
              video and writes results to logs. Output is not added to the UI results list.
            </div>
          </div>

          <button
            type="button"
            class="shrink-0 inline-flex items-center rounded-md border border-indigo-300 dark:border-indigo-700 px-3 py-1.5 text-xs font-medium text-indigo-900 dark:text-indigo-200 bg-white/70 dark:bg-gray-900/40 hover:bg-white dark:hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleRunClick}
            disabled={!canRun()}
          >
            {isRunning() ? 'Running…' : `Run matrix (x${repeats()})`}
          </button>
        </div>

        <div class="mt-4 grid grid-cols-1 gap-3">
          <div class="flex flex-wrap items-center gap-3">
            <label class="text-xs text-indigo-900 dark:text-indigo-200">
              Repeats
              <input
                type="number"
                min={MIN_REPEAT_COUNT}
                max={MAX_REPEAT_COUNT}
                class="ml-2 w-20 rounded-md border border-indigo-300 dark:border-indigo-700 bg-white dark:bg-gray-950 px-2 py-1 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                value={repeats()}
                onInput={updateRepeats}
                disabled={isDisabled()}
              />
            </label>

            <label class="inline-flex items-center gap-2 text-xs text-indigo-900 dark:text-indigo-200">
              <input
                type="checkbox"
                class="h-4 w-4 rounded border-indigo-300 dark:border-indigo-700 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50"
                checked={includeGif()}
                onChange={handleGifToggle}
                disabled={isDisabled()}
              />
              GIF
            </label>

            <label class="inline-flex items-center gap-2 text-xs text-indigo-900 dark:text-indigo-200">
              <input
                type="checkbox"
                class="h-4 w-4 rounded border-indigo-300 dark:border-indigo-700 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50"
                checked={includeWebp()}
                onChange={handleWebpToggle}
                disabled={isDisabled()}
              />
              WebP
            </label>

            <label class="inline-flex items-center gap-2 text-xs text-indigo-900 dark:text-indigo-200">
              <input
                type="checkbox"
                class="h-4 w-4 rounded border-indigo-300 dark:border-indigo-700 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50"
                checked={includeStrategyCodecScenarios()}
                onChange={handleStrategyToggle}
                disabled={isDisabled()}
              />
              Include strategy codec simulations
            </label>

            <label class="inline-flex items-center gap-2 text-xs text-indigo-900 dark:text-indigo-200">
              <input
                type="checkbox"
                class="h-4 w-4 rounded border-indigo-300 dark:border-indigo-700 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50"
                checked={autoDownloadReport()}
                onChange={handleAutoDownloadToggle}
                disabled={isDisabled()}
              />
              Auto-download report (JSON)
            </label>
          </div>

          <Show when={!!inputFile()}>
            <div class="text-[11px] text-indigo-800/80 dark:text-indigo-200/80">
              Using settings: format={conversionSettings().format}, quality=
              {conversionSettings().quality}, scale={conversionSettings().scale}
            </div>
          </Show>

          <Show when={!inputFile()}>
            <div class="text-[11px] text-indigo-800/80 dark:text-indigo-200/80">
              Select a video first to enable matrix testing.
            </div>
          </Show>

          <Show when={isRunning()}>
            <div class="text-[11px] text-indigo-800/80 dark:text-indigo-200/80">
              Running… UI is locked (same as conversion). Use <b>Stop</b> to cancel the test.
              Current status: {conversionStatusMessage()}
            </div>
          </Show>

          <Show when={lastReportId()}>
            <div class="text-[11px] text-indigo-800/80 dark:text-indigo-200/80">
              Last report saved: <span class="font-mono">{lastReportId()}</span>
              <button
                type="button"
                class="ml-2 inline-flex items-center rounded-md border border-indigo-300 dark:border-indigo-700 px-2 py-0.5 text-[11px] font-medium text-indigo-900 dark:text-indigo-200 bg-white/70 dark:bg-gray-900/40 hover:bg-white dark:hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                onClick={handleDownloadLatest}
              >
                Download again
              </button>
            </div>
          </Show>

          <Show when={savedReports().length > 0}>
            <div class="mt-2 rounded-md border border-indigo-200 dark:border-indigo-800 bg-white/50 dark:bg-gray-950/20 p-3">
              <div class="flex items-center justify-between gap-2">
                <div class="text-xs font-semibold text-indigo-900 dark:text-indigo-200">
                  Saved matrix reports (local)
                </div>
                <button
                  type="button"
                  class="inline-flex items-center rounded-md border border-indigo-300 dark:border-indigo-700 px-2 py-1 text-[11px] font-medium text-indigo-900 dark:text-indigo-200 bg-white/70 dark:bg-gray-900/40 hover:bg-white dark:hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  onClick={handleClearReports}
                  disabled={isRunning()}
                >
                  Clear
                </button>
              </div>

              <div class="mt-2 space-y-2">
                {savedReports().map((item) => (
                  <div class="flex flex-wrap items-center justify-between gap-2" role="listitem">
                    <div class="text-[11px] text-indigo-900 dark:text-indigo-200">
                      <span class="font-mono">{item.id}</span>
                      <span class="ml-2 opacity-80">
                        {item.fileName} · {item.successCount}/{item.totalRuns} ok ·{' '}
                        {item.errorCount} err · {Math.round(item.durationMs / 1000)}s
                      </span>
                    </div>
                    <div class="flex items-center gap-2">
                      <button
                        type="button"
                        class="inline-flex items-center rounded-md border border-indigo-300 dark:border-indigo-700 px-2 py-0.5 text-[11px] font-medium text-indigo-900 dark:text-indigo-200 bg-white/70 dark:bg-gray-900/40 hover:bg-white dark:hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        onClick={() => downloadReportById(item.id)}
                      >
                        Download
                      </button>
                      <button
                        type="button"
                        class="inline-flex items-center rounded-md border border-red-300 dark:border-red-700 px-2 py-0.5 text-[11px] font-medium text-red-900 dark:text-red-200 bg-white/70 dark:bg-gray-900/40 hover:bg-white dark:hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
                        onClick={() => handleDeleteReport(item.id)}
                        disabled={isRunning()}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default DevConversionMatrixTest;
