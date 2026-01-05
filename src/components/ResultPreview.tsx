import { type Component, createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import type { ConversionSettings } from '../types/conversion-types';
import { formatBytes } from '../utils/format-bytes';

interface ResultPreviewProps {
  outputBlob: Blob;
  originalName: string;
  originalSize: number;
  settings: ConversionSettings;
  wasTranscoded?: boolean;
  originalCodec?: string;
}

const ResultPreview: Component<ResultPreviewProps> = (props) => {
  // Create blob URL with proper cleanup of previous URLs to prevent memory leaks
  const previewUrl = createMemo<string>((prev) => {
    // Revoke previous blob URL before creating new one
    if (prev) {
      URL.revokeObjectURL(prev);
    }
    return URL.createObjectURL(props.outputBlob);
  }, '');
  const [loaded, setLoaded] = createSignal(false);

  createEffect(() => {
    const url = previewUrl();
    setLoaded(false);
    onCleanup(() => {
      URL.revokeObjectURL(url);
    });
  });

  const handleDownload = () => {
    const url = previewUrl();
    const extension =
      props.outputBlob.type === 'image/gif'
        ? 'gif'
        : props.outputBlob.type === 'image/webp'
          ? 'webp'
          : 'webp';
    const originalName = props.originalName.trim();
    const lastDotIndex = originalName.lastIndexOf('.');
    const baseName =
      originalName && lastDotIndex > 0 ? originalName.slice(0, lastDotIndex) : originalName;
    const safeBaseName = baseName.trim() ? baseName : 'converted';
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeBaseName}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6">
      <div class="flex gap-3">
        <button
          type="button"
          data-download-button
          class="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-gray-900"
          onClick={handleDownload}
        >
          Download
        </button>
      </div>

      <div class="mt-4 flex justify-center bg-gray-50 dark:bg-gray-950 rounded-lg p-4 relative overflow-hidden">
        <div
          class={`absolute inset-0 transition-opacity duration-300 ${loaded() ? 'opacity-0' : 'opacity-100'}`}
        >
          <div class="w-full h-full bg-gray-200 dark:bg-gray-800 animate-pulse rounded" />
        </div>
        <img
          src={previewUrl()}
          alt="Converted animation"
          class={`max-w-full h-auto rounded transition-opacity duration-300 ${loaded() ? 'opacity-100' : 'opacity-0'}`}
          onLoad={() => setLoaded(true)}
          loading="lazy"
        />
      </div>

      <div class="mt-4">
        <h3 class="text-lg font-medium text-gray-900 dark:text-white">Conversion Complete</h3>

        <Show when={props.wasTranscoded}>
          <div class="mt-3 p-3 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg">
            <div class="flex items-start">
              <div class="flex-shrink-0">
                <svg
                  class="h-5 w-5 text-blue-600 dark:text-blue-400"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fill-rule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                    clip-rule="evenodd"
                  />
                </svg>
              </div>
              <div class="ml-3 flex-1">
                <p class="text-sm text-blue-800 dark:text-blue-200">
                  Video was transcoded from <span class="font-medium">{props.originalCodec}</span>{' '}
                  to H.264 for compatibility
                </p>
              </div>
            </div>
          </div>
        </Show>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm mt-3">
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Original Size</div>
            <div class="font-medium text-gray-900 dark:text-white">
              {formatBytes(props.originalSize)}
            </div>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Output Size</div>
            <div class="font-medium text-gray-900 dark:text-white">
              {formatBytes(props.outputBlob.size)}
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm mt-3">
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Format</div>
            <div class="font-medium text-gray-900 dark:text-white uppercase">
              {props.settings.format}
            </div>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Quality</div>
            <div class="font-medium text-gray-900 dark:text-white capitalize">
              {props.settings.quality}
            </div>
          </div>
          <div class="bg-gray-50 dark:bg-gray-950 rounded-lg p-3">
            <div class="text-gray-600 dark:text-gray-400">Scale</div>
            <div class="font-medium text-gray-900 dark:text-white">
              {(props.settings.scale * 100).toFixed(0)}%
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ResultPreview;
