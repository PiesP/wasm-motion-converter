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
  'inline-flex justify-center items-center px-4 py-2 border text-sm font-medium rounded-md disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(94,106,210,0.5)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f1011] transition-all duration-150';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'border-transparent text-white bg-[#5e6ad2] hover:bg-[#828fff]',
  danger: 'border-transparent text-white bg-red-600/80 hover:bg-red-500',
  ghost: 'border-white/[0.08] text-[#d0d6e0] bg-white/[0.02] hover:bg-white/[0.05]',
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
