/**
 * Network connectivity detection and adaptive resource loading
 */

/**
 * Network information type
 */
export interface NetworkInfo {
  /** Effective type: 'slow-2g' | '2g' | '3g' | '4g' | 'unknown' */
  effectiveType: string;
  /** True if device is connected to internet */
  isOnline: boolean;
  /** Estimate of round-trip time in ms */
  roundTripTime?: number;
  /** Estimate of downlink speed in Mbps */
  downlink?: number;
}

interface ConnectionInfo {
  effectiveType?: string;
  rtt?: number;
  downlink?: number;
}

/**
 * Get the Connection API object if available
 * @returns Connection object or null
 */
function getConnectionObject(): ConnectionInfo | null {
  if (typeof navigator === 'undefined') {
    return null;
  }

  const nav = navigator as Navigator & {
    connection?: ConnectionInfo;
    mozConnection?: ConnectionInfo;
    webkitConnection?: ConnectionInfo;
  };

  return nav.connection || nav.mozConnection || nav.webkitConnection || null;
}

/**
 * Detect current network condition
 * @returns Network information object
 */
export function getNetworkInfo(): NetworkInfo {
  const isOnline = typeof navigator !== 'undefined' && navigator.onLine;
  const connection = getConnectionObject();

  const effectiveType = connection?.effectiveType ?? 'unknown';
  const roundTripTime = connection?.rtt;
  const downlink = connection?.downlink;

  return {
    effectiveType,
    isOnline,
    roundTripTime,
    downlink,
  };
}

/**
 * Determine if network is fast enough for prefetching
 * @returns True if network is fast (4g) or unknown
 */
export function isFastNetwork(): boolean {
  const info = getNetworkInfo();
  // Prefetch on 4g or unknown connections (assume it's fast)
  return info.effectiveType === '4g' || info.effectiveType === 'unknown';
}

/**
 * Determine if network is slow and requires optimization
 * @returns True if network is slow-2g, 2g, or 3g
 */
export function isSlowNetwork(): boolean {
  const info = getNetworkInfo();
  return ['slow-2g', '2g', '3g'].includes(info.effectiveType);
}

/**
 * Determine if device is offline
 * @returns True if device is offline
 */
export function isOffline(): boolean {
  return !getNetworkInfo().isOnline;
}

/**
 * Get recommended delay for resource loading based on network condition
 * @returns Delay in milliseconds
 */
export function getResourceLoadingDelay(): number {
  const info = getNetworkInfo();

  switch (info.effectiveType) {
    case 'slow-2g':
      return 5000; // Wait longer before loading large resources
    case '2g':
      return 3000;
    case '3g':
      return 1000;
    default:
      return 100; // Minimal delay for fast networks or unknown
  }
}

/**
 * Setup listener for network change events
 * @param callback - Function to call when network status changes
 * @returns Cleanup function to remove listener
 */
export function onNetworkChange(callback: (info: NetworkInfo) => void): () => void {
  const connection = getConnectionObject();

  if (!connection) {
    return () => {};
  }

  const handleChange = () => {
    callback(getNetworkInfo());
  };

  const nav = navigator as Navigator & {
    connection?: ConnectionInfo & {
      addEventListener: (event: string, listener: () => void) => void;
      removeEventListener: (event: string, listener: () => void) => void;
    };
    mozConnection?: ConnectionInfo & {
      addEventListener: (event: string, listener: () => void) => void;
      removeEventListener: (event: string, listener: () => void) => void;
    };
    webkitConnection?: ConnectionInfo & {
      addEventListener: (event: string, listener: () => void) => void;
      removeEventListener: (event: string, listener: () => void) => void;
    };
  };

  const connObj = nav.connection || nav.mozConnection || nav.webkitConnection;

  connObj?.addEventListener?.('change', handleChange);

  return () => {
    connObj?.removeEventListener?.('change', handleChange);
  };
}

/**
 * Listen for online/offline events
 * @param onOnline - Callback when device comes online
 * @param onOffline - Callback when device goes offline
 * @returns Cleanup function to remove listeners
 */
export function onConnectivityChange(onOnline?: () => void, onOffline?: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleOnline = () => onOnline?.();
  const handleOffline = () => onOffline?.();

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}
