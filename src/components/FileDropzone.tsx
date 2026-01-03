import { type Component, createEffect, createSignal, onCleanup } from 'solid-js';
import { formatDuration } from '../utils/format-duration';

interface FileDropzoneProps {
  onFileSelected: (file: File) => void;
  disabled?: boolean;
  progress?: number;
  status?: string;
  statusMessage?: string;
  showElapsedTime?: boolean;
  startTime?: number;
}

const FileDropzone: Component<FileDropzoneProps> = (props) => {
  const [isDragging, setIsDragging] = createSignal(false);
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0);

  const isBusy = () => Boolean(props.status);
  const isInteractive = () => !props.disabled && !isBusy();
  const progressValue = () => {
    const raw = props.progress ?? 0;
    if (!Number.isFinite(raw)) {
      return 0;
    }
    return Math.min(100, Math.max(0, Math.round(raw)));
  };

  createEffect(() => {
    if (!isBusy() || !props.showElapsedTime || !props.startTime) {
      setElapsedSeconds(0);
      return;
    }
    const updateElapsed = () => {
      const elapsed = Math.floor((Date.now() - props.startTime!) / 1000);
      setElapsedSeconds(elapsed);
    };
    updateElapsed();
    const interval = setInterval(() => {
      updateElapsed();
    }, 1000);

    onCleanup(() => {
      clearInterval(interval);
    });
  });

  const selectFile = (files?: FileList | null) => {
    const file = files?.[0];
    if (file) {
      props.onFileSelected(file);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (!isInteractive()) {
      return;
    }
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (!isInteractive()) {
      return;
    }
    selectFile(e.dataTransfer?.files);
  };

  const handleFileInput = (e: Event) => {
    if (!isInteractive()) {
      return;
    }
    const input = e.target as HTMLInputElement;
    selectFile(input.files);
  };

  const dropzoneStateClass = () => {
    if (isBusy()) {
      return 'border-blue-500 bg-blue-50 dark:bg-blue-950 dark:border-blue-400';
    }
    if (isDragging()) {
      return 'border-blue-500 bg-blue-50 dark:bg-blue-950 dark:border-blue-400';
    }
    return 'border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-gray-400 dark:hover:border-gray-600';
  };

  return (
    <div
      class={`border-2 border-dashed rounded-lg p-12 text-center transition-colors ${dropzoneStateClass()} ${
        props.disabled && !isBusy() ? 'opacity-60 cursor-not-allowed' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      tabIndex={isInteractive() ? 0 : -1}
      onKeyDown={(e) => {
        if (isInteractive() && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          document.getElementById('file-upload')?.click();
        }
      }}
      role="button"
      aria-label="Drop video file here or press Enter to select a file"
      aria-disabled={!isInteractive()}
    >
      {isBusy() ? (
        <div class="flex flex-col items-center gap-4">
          <div class="flex items-center gap-3 text-sm font-medium text-gray-700 dark:text-gray-200">
            <svg class="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24" aria-hidden="true">
              <circle
                class="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                stroke-width="4"
              />
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <span>{props.status}</span>
            <span class="text-gray-600 dark:text-gray-400">{progressValue()}%</span>
          </div>
          <div
            class="w-full max-w-md bg-gray-200 dark:bg-gray-800 rounded-full h-2.5"
            role="progressbar"
            aria-valuenow={progressValue()}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={props.status || 'Processing'}
          >
            <div
              class="bg-blue-600 dark:bg-blue-500 h-2.5 rounded-full transition-all duration-300"
              style={{ width: `${progressValue()}%` }}
            />
          </div>
          <div class="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-2">
            <span>Processing...</span>
            {props.showElapsedTime && props.startTime && (
              <span class="font-mono">({formatDuration(elapsedSeconds())})</span>
            )}
          </div>
          {props.statusMessage ? (
            <p class="text-xs text-gray-600 dark:text-gray-400 italic">{props.statusMessage}</p>
          ) : null}
        </div>
      ) : (
        <>
          <svg
            class="mx-auto h-12 w-12 text-gray-400 dark:text-gray-600"
            stroke="currentColor"
            fill="none"
            viewBox="0 0 48 48"
          >
            <path
              d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <div class="mt-4">
            <label
              for="file-upload"
              class="cursor-pointer inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-gray-900"
            >
              Choose a video file
              <input
                id="file-upload"
                type="file"
                class="sr-only"
                accept="video/*"
                onChange={handleFileInput}
                disabled={props.disabled}
              />
            </label>
          </div>
          <p class="mt-2 text-sm text-gray-600 dark:text-gray-400">or drag and drop</p>
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-500">
            MP4, MOV, WebM, AVI, MKV (max 500MB)
          </p>
        </>
      )}
    </div>
  );
};

export default FileDropzone;
