import { type Component, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { formatBytes } from '../utils/format-bytes';

interface ResultPreviewProps {
  outputBlob: Blob;
  originalName: string;
  originalSize: number;
}

const ResultPreview: Component<ResultPreviewProps> = (props) => {
  const previewUrl = createMemo(() => URL.createObjectURL(props.outputBlob));
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
    const extension = props.outputBlob.type === 'image/gif' ? 'gif' : 'webp';
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
      <button
        type="button"
        class="w-full inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-gray-900"
        onClick={handleDownload}
      >
        Download
      </button>

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
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 mb-4">{props.originalName}</p>

        <div class="grid grid-cols-2 gap-4 text-sm">
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
      </div>
    </div>
  );
};

export default ResultPreview;
