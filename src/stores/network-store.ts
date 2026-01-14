import { createSignal, onCleanup, onMount } from 'solid-js';

export type NetworkState = {
  online: boolean;
  effectiveType: '4g' | '3g' | '2g' | 'slow-2g' | 'unknown';
  saveData: boolean;
};

/**
 * Network Information API interface (not in standard TypeScript lib)
 */
interface NetworkInformation extends EventTarget {
  effectiveType?: '4g' | '3g' | '2g' | 'slow-2g';
  saveData?: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformation;
  mozConnection?: NetworkInformation;
  webkitConnection?: NetworkInformation;
}

const [networkState, setNetworkState] = createSignal<NetworkState>({
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  effectiveType: 'unknown',
  saveData: false,
});

/**
 * Initialize network state monitoring
 */
export function useNetworkState() {
  onMount(() => {
    const updateOnlineStatus = () => {
      setNetworkState((prev) => ({ ...prev, online: navigator.onLine }));
    };

    const updateConnectionInfo = () => {
      const nav = navigator as NavigatorWithConnection;
      const conn = nav.connection || nav.mozConnection || nav.webkitConnection;

      if (conn) {
        setNetworkState((prev) => ({
          ...prev,
          effectiveType: conn.effectiveType || 'unknown',
          saveData: conn.saveData || false,
        }));
      }
    };

    // Listen for online/offline events
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);

    // Listen for connection changes
    const conn = (navigator as NavigatorWithConnection).connection;
    if (conn) {
      conn.addEventListener('change', updateConnectionInfo);
    }

    // Initial check
    updateOnlineStatus();
    updateConnectionInfo();

    onCleanup(() => {
      window.removeEventListener('online', updateOnlineStatus);
      window.removeEventListener('offline', updateOnlineStatus);

      if (conn) {
        conn.removeEventListener('change', updateConnectionInfo);
      }
    });
  });

  return networkState;
}

export { networkState };
