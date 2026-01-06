/**
 * Application Types
 *
 * Core type definitions for application-wide state and configuration.
 * These types are used across stores, components, and services to ensure
 * type safety and consistency throughout the application.
 */

/**
 * Application state
 *
 * Represents the high-level workflow state of the application.
 *
 * - `idle`: Initial state, waiting for user to select a video file
 * - `loading-ffmpeg`: Downloading and initializing FFmpeg.wasm (~30MB)
 * - `analyzing`: Extracting video metadata (duration, dimensions, codec)
 * - `converting`: Active video conversion in progress
 * - `done`: Conversion completed successfully, results available
 * - `error`: An error occurred, error message displayed to user
 *
 * @example
 * // In a store
 * export const [appState, setAppState] = createSignal<AppState>('idle');
 *
 * @example
 * // In a component
 * <Show when={appState() === 'converting'}>
 *   <ConversionProgress />
 * </Show>
 */
export type AppState = 'idle' | 'loading-ffmpeg' | 'analyzing' | 'converting' | 'done' | 'error';
