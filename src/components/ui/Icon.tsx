import { type Component, type JSX, Match, Switch, splitProps } from 'solid-js';

/**
 * Available icon names
 */
export type IconName =
  | 'info'
  | 'warning'
  | 'error'
  | 'success'
  | 'download'
  | 'upload'
  | 'spinner'
  | 'check'
  | 'x'
  | 'chevron-down'
  | 'moon'
  | 'sun';

/**
 * Icon size variants
 */
export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Icon component props
 */
export interface IconProps extends Omit<JSX.SvgSVGAttributes<SVGSVGElement>, 'name'> {
  /** Name of the icon to display */
  name: IconName;
  /** Size variant of the icon (default: 'md') */
  size?: IconSize;
  /** Custom CSS class names */
  class?: string;
  /** Whether the icon is decorative or conveys meaning */
  'aria-hidden'?: boolean | 'true' | 'false';
}

/**
 * Icon component for displaying SVG icons
 *
 * @example
 * ```tsx
 * <Icon name="success" size="lg" aria-hidden={false} />
 * <Icon name="spinner" size="sm" class="animate-spin" />
 * ```
 */
const Icon: Component<IconProps> = (props) => {
  const [local, others] = splitProps(props, ['name', 'size', 'class', 'aria-hidden']);

  const size = () => local.size ?? 'md';

  const sizeClasses = (): string => {
    switch (size()) {
      case 'xs':
        return 'h-3 w-3';
      case 'sm':
        return 'h-4 w-4';
      case 'md':
        return 'h-5 w-5';
      case 'lg':
        return 'h-6 w-6';
      case 'xl':
        return 'h-8 w-8';
    }
  };

  const combinedClasses = (): string => [sizeClasses(), local.class].filter(Boolean).join(' ');

  const ariaHidden = () => local['aria-hidden'] ?? true;

  return (
    <svg
      {...others}
      class={combinedClasses()}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden={ariaHidden()}
    >
      <Switch>
        <Match when={local.name === 'info'}>
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </Match>

        <Match when={local.name === 'warning'}>
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </Match>

        <Match when={local.name === 'error'}>
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </Match>

        <Match when={local.name === 'success'}>
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </Match>

        <Match when={local.name === 'download'}>
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
          />
        </Match>

        <Match when={local.name === 'upload'}>
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
          />
        </Match>

        <Match when={local.name === 'spinner'}>
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          />
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </Match>

        <Match when={local.name === 'check'}>
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M5 13l4 4L19 7"
          />
        </Match>

        <Match when={local.name === 'x'}>
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M6 18L18 6M6 6l12 12"
          />
        </Match>

        <Match when={local.name === 'chevron-down'}>
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M19 9l-7 7-7-7"
          />
        </Match>

        <Match when={local.name === 'moon'}>
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
          />
        </Match>

        <Match when={local.name === 'sun'}>
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
          />
        </Match>
      </Switch>
    </svg>
  );
};

export default Icon;
