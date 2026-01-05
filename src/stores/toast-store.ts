import { createSignal } from 'solid-js';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);

export function showToast(message: string, type: ToastType = 'info', duration = 3000) {
  const id = crypto.randomUUID();
  setToasts((prev) => [...prev, { id, type, message, duration }]);

  if (duration > 0) {
    setTimeout(() => removeToast(id), duration);
  }
}

export function removeToast(id: string) {
  setToasts((prev) => prev.filter((t) => t.id !== id));
}

export { toasts };
