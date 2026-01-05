import { type Component, type JSX, Show, splitProps } from 'solid-js';
import Icon, { type IconName } from './Icon';

export type AlertType = 'info' | 'warning' | 'error' | 'success';

export interface AlertProps extends JSX.HTMLAttributes<HTMLDivElement> {
  type: AlertType;
  title?: string;
  message: string;
  dismissible?: boolean;
  onDismiss?: () => void;
}

const Alert: Component<AlertProps> = (props) => {
  const [local, others] = splitProps(props, [
    'type',
    'title',
    'message',
    'dismissible',
    'onDismiss',
    'class',
  ]);

  const iconName = (): IconName => {
    switch (local.type) {
      case 'info':
        return 'info';
      case 'warning':
        return 'warning';
      case 'error':
        return 'error';
      case 'success':
        return 'success';
      default:
        return 'info';
    }
  };

  const typeClasses = () => {
    switch (local.type) {
      case 'info':
        return 'bg-blue-50 dark:bg-blue-950 border-blue-400 dark:border-blue-500 text-blue-700 dark:text-blue-300';
      case 'warning':
        return 'bg-yellow-50 dark:bg-yellow-950 border-yellow-400 dark:border-yellow-500 text-yellow-700 dark:text-yellow-300';
      case 'error':
        return 'bg-red-50 dark:bg-red-950 border-red-400 dark:border-red-500 text-red-700 dark:text-red-300';
      case 'success':
        return 'bg-green-50 dark:bg-green-950 border-green-400 dark:border-green-500 text-green-700 dark:text-green-300';
      default:
        return '';
    }
  };

  const combinedClasses = () =>
    ['border-l-4 p-4 rounded', typeClasses(), local.class].filter(Boolean).join(' ');

  return (
    <div {...others} class={combinedClasses()} role="alert">
      <div class="flex items-start">
        <div class="flex-shrink-0">
          <Icon name={iconName()} size="md" />
        </div>
        <div class="ml-3 flex-1">
          <Show when={local.title}>
            <h3 class="text-sm font-medium mb-1">{local.title}</h3>
          </Show>
          <div class="text-sm">{local.message}</div>
        </div>
        <Show when={local.dismissible && local.onDismiss}>
          <div class="ml-auto pl-3">
            <button
              type="button"
              class="inline-flex rounded-md p-1.5 hover:bg-black/10 dark:hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-offset-2"
              onClick={local.onDismiss}
              aria-label="Dismiss"
            >
              <Icon name="x" size="sm" />
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default Alert;
