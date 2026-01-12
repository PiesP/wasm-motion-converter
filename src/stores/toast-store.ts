/**
 * Toast Store
 *
 * Manages temporary notification toasts with automatic dismissal. Toasts are
 * displayed at the top of the application and automatically removed after
 * their duration expires. Supports different types (success, error, info, warning)
 * for visual differentiation.
 */

// External dependencies
import { createSignal } from "solid-js";

// Internal dependencies
import { createId } from "@utils/create-id";
import { logger } from "@utils/logger";

/**
 * Toast notification type
 *
 * - success: Green toast for successful operations
 * - error: Red toast for error conditions
 * - info: Blue toast for informational messages
 * - warning: Yellow toast for warning conditions
 */
export type ToastType = "success" | "error" | "info" | "warning";

/**
 * Toast notification
 *
 * Represents a single toast message with auto-dismissal.
 */
export interface Toast {
  /** Unique identifier (UUID) */
  id: string;
  /** Visual type of the toast */
  type: ToastType;
  /** Message to display */
  message: string;
  /** Auto-dismiss duration in milliseconds (0 = manual dismissal only) */
  duration?: number;
}

/**
 * Default toast duration in milliseconds
 */
const DEFAULT_TOAST_DURATION = 3000;

/**
 * Currently displayed toasts
 *
 * Array of active toast notifications. Toasts are automatically removed after
 * their duration expires, or can be manually dismissed by the user.
 */
const [toasts, setToasts] = createSignal<Toast[]>([]);

/**
 * Export toasts signal getter
 */
export { toasts };

/**
 * Show a toast notification
 *
 * Displays a toast message that will automatically disappear after the specified
 * duration. If duration is 0, the toast will persist until manually dismissed.
 *
 * @param message - Message to display in the toast
 * @param type - Visual type of the toast (default: 'info')
 * @param duration - Auto-dismiss duration in milliseconds (default: 3000, 0 = no auto-dismiss)
 *
 * @example
 * // Show success toast
 * showToast('Conversion completed!', 'success');
 *
 * @example
 * // Show error toast with longer duration
 * showToast('Failed to load video', 'error', 5000);
 *
 * @example
 * // Show persistent toast (manual dismissal only)
 * showToast('Processing...', 'info', 0);
 */
export function showToast(
  message: string,
  type: ToastType = "info",
  duration: number = DEFAULT_TOAST_DURATION
): void {
  const id = createId();
  const toast: Toast = { id, type, message, duration };

  setToasts((prev) => [...prev, toast]);

  logger.info("general", "Toast shown", { type, message, duration });

  // Schedule auto-dismissal if duration > 0
  if (duration > 0) {
    setTimeout(() => removeToast(id), duration);
  }
}

/**
 * Remove a toast notification
 *
 * Manually dismisses a toast by its ID. This is called automatically when
 * the toast's duration expires, or can be called manually when the user
 * clicks the close button.
 *
 * @param id - Unique ID of the toast to remove
 *
 * @example
 * // Remove specific toast
 * removeToast(toastId);
 */
export function removeToast(id: string): void {
  setToasts((prev) => prev.filter((t) => t.id !== id));
  logger.debug("general", "Toast removed", { id });
}
