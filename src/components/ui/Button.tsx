// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { Component, JSX } from 'solid-js';
import { splitProps } from 'solid-js';

type ButtonVariant = 'primary' | 'danger' | 'ghost';

interface ButtonProps {
  variant?: ButtonVariant;
  type?: 'button' | 'submit' | 'reset';
  class?: string;
  disabled?: boolean;
  ariaLabel?: string;
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
  children: JSX.Element;
  'data-testid'?: string;
}

const BASE_CLASS =
  'inline-flex justify-center items-center px-4 py-2 min-h-target-minimum border text-sm font-medium rounded-button disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-panel transition-[color,background-color,border-color,opacity] duration-standard ease-standard';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'border-transparent text-brand-foreground bg-brand hover:bg-brand-hover',
  danger: 'border-transparent text-bg-base bg-status-danger hover:bg-status-danger-hover',
  ghost: 'border-border-standard text-text-secondary bg-white/[0.02] hover:bg-white/[0.05]',
};

const Button: Component<ButtonProps> = (props) => {
  const [local, others] = splitProps(props, [
    'variant',
    'type',
    'class',
    'disabled',
    'ariaLabel',
    'onClick',
    'children',
    'data-testid',
  ]);

  const variant = () => local.variant ?? 'primary';
  const className = () => `${BASE_CLASS} ${VARIANT_CLASSES[variant()]} ${local.class ?? ''}`.trim();

  return (
    <button
      {...others}
      type={local.type ?? 'button'}
      class={className()}
      disabled={local.disabled}
      aria-label={local.ariaLabel}
      onClick={local.onClick}
      data-testid={local['data-testid']}
    >
      {local.children}
    </button>
  );
};

export default Button;
