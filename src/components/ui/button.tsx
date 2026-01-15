import type { Component, JSX } from 'solid-js';

export type ButtonVariant = 'primary' | 'danger' | 'ghost';

interface ButtonProps {
  variant?: ButtonVariant;
  type?: 'button' | 'submit' | 'reset';
  class?: string;
  disabled?: boolean;
  ariaLabel?: string;
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
  children: JSX.Element;
  'data-download-button'?: boolean;
}

const baseClass =
  'inline-flex justify-center items-center px-4 py-2 border text-sm font-medium rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed';

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'border-transparent text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:ring-blue-500',
  danger:
    'border-transparent text-white bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800 focus:ring-red-500',
  ghost:
    'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:ring-gray-500',
};

const Button: Component<ButtonProps> = (props) => {
  const variant = props.variant ?? 'primary';

  return (
    <button
      type={props.type ?? 'button'}
      class={`${baseClass} ${variantClasses[variant]} ${props.class ?? ''}`.trim()}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      onClick={props.onClick}
      data-download-button={props['data-download-button']}
    >
      {props.children}
    </button>
  );
};

export default Button;
