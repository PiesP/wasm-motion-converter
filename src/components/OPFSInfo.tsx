import { type Component, createSignal, onMount, Show } from 'solid-js';
import { isOPFSSupported } from '../utils/opfs-support';

/**
 * Display information about OPFS (Origin Private File System) support
 * Shows whether browser supports disk-based file operations for better performance
 */
const OPFSInfo: Component = () => {
  const [opfsSupported, setOPFSSupported] = createSignal(false);

  onMount(() => {
    setOPFSSupported(isOPFSSupported());
  });

  return (
    <Show when={opfsSupported()}>
      <div class="bg-blue-50 dark:bg-blue-950 border-l-4 border-blue-400 dark:border-blue-500 p-4 mb-6">
        <div class="flex">
          <div class="flex-shrink-0">
            <svg
              class="h-5 w-5 text-blue-400 dark:text-blue-500"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fill-rule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                clip-rule="evenodd"
              />
            </svg>
          </div>
          <div class="ml-3">
            <h3 class="text-sm font-medium text-blue-800 dark:text-blue-300">
              Enhanced Performance Available
            </h3>
            <div class="mt-2 text-sm text-blue-700 dark:text-blue-400">
              <p>
                Your browser supports <strong>OPFS (Origin Private File System)</strong>, which
                enables disk-based file operations for better performance with large files.
              </p>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default OPFSInfo;
