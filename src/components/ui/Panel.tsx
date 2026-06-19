// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { Component, ParentProps } from 'solid-js';
import { splitProps } from 'solid-js';

interface PanelProps extends ParentProps {
  class?: string;
  role?: 'region' | 'group' | 'presentation' | 'status' | 'alert';
  ariaLabel?: string;
  ariaLive?: 'polite' | 'assertive' | 'off';
  ariaBusy?: boolean;
}

const Panel: Component<PanelProps> = (props) => {
  const [local, others] = splitProps(props, [
    'class',
    'role',
    'ariaLabel',
    'ariaLive',
    'ariaBusy',
    'children',
  ]);

  const className = () =>
    `bg-[#0f1011] border border-white/[0.08] rounded-lg transition-all duration-150 ${local.class ?? ''}`.trim();

  return (
    <div
      {...others}
      class={className()}
      role={local.role}
      aria-label={local.ariaLabel}
      aria-live={local.ariaLive}
      aria-busy={local.ariaBusy}
    >
      {local.children}
    </div>
  );
};

export default Panel;
