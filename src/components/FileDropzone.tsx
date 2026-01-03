import { type Component, createSignal } from 'solid-js';

interface FileDropzoneProps {
  onFileSelected: (file: File) => void;
}

const FileDropzone: Component<FileDropzoneProps> = (props) => {
  const [isDragging, setIsDragging] = createSignal(false);

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file) {
        props.onFileSelected(file);
      }
    }
  };

  const handleFileInput = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file) {
        props.onFileSelected(file);
      }
    }
  };

  return (
    <div
      class={`border-2 border-dashed rounded-lg p-12 text-center transition-colors ${
        isDragging()
          ? 'border-blue-500 bg-blue-50 dark:bg-blue-950 dark:border-blue-400'
          : 'border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-gray-400 dark:hover:border-gray-600'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
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
          />
        </label>
      </div>
      <p class="mt-2 text-sm text-gray-600 dark:text-gray-400">or drag and drop</p>
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-500">
        MP4, MOV, WebM, AVI, MKV (max 500MB)
      </p>
    </div>
  );
};

export default FileDropzone;
