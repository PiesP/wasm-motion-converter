// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { Component, JSX } from 'solid-js';
import { createSignal, onCleanup, Show, splitProps } from 'solid-js';

const TOOLTIP_Z_INDEX = 'z-10';
const TOOLTIP_ARROW_SIZE = 'w-2 h-2';
const TOOLTIP_MARGIN_PX = 4;
const TOOLTIP_ESTIMATED_HEIGHT = 40;

interface TooltipProps {
  content: string;
  children: JSX.Element;
}

const Tooltip: Component<TooltipProps> = (props) => {
  const [local] = splitProps(props, ['content', 'children']);
  const [isVisible, setIsVisible] = createSignal(false);
  const [placement, setPlacement] = createSignal<'above' | 'below'>('above');
  const [tooltipId] = createSignal(`tooltip-${crypto.randomUUID()}`);
  let triggerEl: HTMLDivElement | undefined;

  const showTooltip = () => {
    // Check if showing above would overflow viewport
    const triggerRect = triggerEl?.getBoundingClientRect();
    if (triggerRect) {
      if (triggerRect.top - TOOLTIP_ESTIMATED_HEIGHT - TOOLTIP_MARGIN_PX < 0) {
        setPlacement('below');
      } else {
        setPlacement('above');
      }
    }
    setIsVisible(true);
  };

  const hideTooltip = () => {
    setIsVisible(false);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && isVisible()) {
      hideTooltip();
    }
  };

  onCleanup(() => {
    triggerEl = undefined;
  });

  const tooltipClass = () => (placement() === 'above' ? 'bottom-full mb-1' : 'top-full mt-1');

  const arrowClass = () => (placement() === 'above' ? '-bottom-1' : '-top-1');

  return (
    <div class="relative inline-block">
      <div
        ref={(el) => {
          triggerEl = el;
        }}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        onKeyDown={handleKeyDown}
        aria-describedby={tooltipId()}
      >
        {local.children}
      </div>
      <Show when={isVisible()}>
        <div
          id={tooltipId()}
          class={`absolute ${TOOLTIP_Z_INDEX} px-3 py-2 text-xs text-[#f7f8f8] bg-[#191a1b] rounded-lg shadow-lg ${tooltipClass()} left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none`}
          role="tooltip"
        >
          {local.content}
          <div
            class={`absolute ${TOOLTIP_ARROW_SIZE} bg-[#191a1b] rotate-45 left-1/2 -translate-x-1/2 ${arrowClass()}`}
          />
        </div>
      </Show>
    </div>
  );
};

export default Tooltip;
