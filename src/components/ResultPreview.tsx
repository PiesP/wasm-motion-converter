import { type Component, createEffect, createMemo, onCleanup } from 'solid-js';
import { formatBytes } from '../utils/format-bytes';

interface ResultPreviewProps {
  outputBlob: Blob;
  originalSize: number;
  originalName: string;
  onReset: () => void;
}

const ResultPreview: Component<ResultPreviewProps> = (props) => {
  const previewUrl = createMemo(() => URL.createObjectURL(props.outputBlob));

  createEffect(() => {
    const url = previewUrl();
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
      <h3 class="text-lg font-medium text-gray-900 dark:text-white mb-4">Conversion Complete</h3>

      <div class="mb-4 flex justify-center bg-gray-50 dark:bg-gray-950 rounded-lg p-4">
        <img src={previewUrl()} alt="Converted animation" class="max-w-full h-auto rounded" />
      </div>

      <div class="mb-4 grid grid-cols-2 gap-4 text-sm">
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

      <div class="flex gap-3">
        <button
          type="button"
          class="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-gray-900"
          onClick={handleDownload}
        >
          Download
        </button>
        <button
          type="button"
          class="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 dark:border-gray-700 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 dark:focus:ring-offset-gray-900"
          onClick={props.onReset}
        >
          Convert Another
        </button>
      </div>
    </div>
  );
};

export default ResultPreview;
