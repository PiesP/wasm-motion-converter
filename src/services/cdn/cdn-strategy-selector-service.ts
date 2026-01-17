/**
 * CDN Strategy Selector
 *
 * Selects optimal CDN fetching strategy based on network connection type.
 * Balances performance (parallel racing) with bandwidth conservation
 * (sequential cascade on slow connections).
 *
 * Strategy Selection:
 * - WiFi/4G: Parallel racing for faster loads
 * - 3G: Sequential cascade with adaptive timeout (1.5x)
 * - 2G/slow: Sequential cascade, standard timeout (2x), skip prefetch
 * - Unknown: Conservative sequential cascade
 */

/**
 * CDN fetching strategy types
 */
export type CDNStrategy = 'parallel-racing' | 'sequential-cascade';

/**
 * Connection type categories
 */
export type ConnectionType = 'fast' | 'medium' | 'slow' | 'unknown';

/**
 * Strategy recommendation with configuration
 */
export interface StrategyRecommendation {
  /** Recommended strategy */
  strategy: CDNStrategy;
  /** Connection type detected */
  connectionType: ConnectionType;
  /** Timeout multiplier (1.0 = base, 1.5 = 3G, 2.0 = 2G) */
  timeoutMultiplier: number;
  /** Whether to enable prefetching */
  enablePrefetch: boolean;
  /** Whether to enable parallel racing */
  enableParallelRacing: boolean;
}

/**
 * NetworkInformation API types (experimental)
 * See: https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation
 */
interface NetworkInformation extends EventTarget {
  effectiveType?: '4g' | '3g' | '2g' | 'slow-2g';
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

/**
 * Extended Navigator interface with connection property
 */
interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformation;
}

/**
 * Detects the current network connection type
 * Uses NetworkInformation API when available
 *
 * @returns Connection type category
 */
export function detectConnectionType(): ConnectionType {
  try {
    const nav = navigator as NavigatorWithConnection;
    const connection = nav.connection;

    if (!connection) {
      return 'unknown';
    }

    if (connection.saveData) {
      return 'slow';
    }

    if (connection.effectiveType) {
      switch (connection.effectiveType) {
        case '4g':
          return 'fast';
        case '3g':
          return 'medium';
        case '2g':
        case 'slow-2g':
          return 'slow';
        default:
          return 'unknown';
      }
    }

    if (connection.rtt !== undefined) {
      if (connection.rtt < 100) {
        return 'fast';
      }
      if (connection.rtt < 400) {
        return 'medium';
      }
      return 'slow';
    }

    if (connection.downlink !== undefined) {
      if (connection.downlink > 5) {
        return 'fast';
      }
      if (connection.downlink > 1) {
        return 'medium';
      }
      return 'slow';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Selects optimal CDN strategy based on connection type
 *
 * @param connectionType - Detected connection type (optional, auto-detects if not provided)
 * @returns Strategy recommendation with configuration
 */
export function selectStrategy(connectionType?: ConnectionType): StrategyRecommendation {
  const detectedType = connectionType ?? detectConnectionType();

  switch (detectedType) {
    case 'fast':
      return {
        strategy: 'parallel-racing',
        connectionType: 'fast',
        timeoutMultiplier: 1.0,
        enablePrefetch: true,
        enableParallelRacing: true,
      };

    case 'medium':
      return {
        strategy: 'sequential-cascade',
        connectionType: 'medium',
        timeoutMultiplier: 1.5,
        enablePrefetch: false,
        enableParallelRacing: false,
      };

    case 'slow':
      return {
        strategy: 'sequential-cascade',
        connectionType: 'slow',
        timeoutMultiplier: 2.0,
        enablePrefetch: false,
        enableParallelRacing: false,
      };
    default:
      return {
        strategy: 'sequential-cascade',
        connectionType: 'unknown',
        timeoutMultiplier: 1.0,
        enablePrefetch: false,
        enableParallelRacing: false,
      };
  }
}

/**
 * Checks if prefetching should be enabled for current connection
 *
 * @param connectionType - Connection type (optional, auto-detects if not provided)
 * @returns Whether to enable prefetching
 */
export function shouldEnablePrefetch(connectionType?: ConnectionType): boolean {
  const strategy = selectStrategy(connectionType);
  return strategy.enablePrefetch;
}
