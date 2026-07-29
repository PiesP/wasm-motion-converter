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
  children: (triggerProps: TooltipTriggerProps) => JSX.Element;
}

interface TooltipTriggerProps {
  'aria-describedby': string;
  onMouseEnter: (event: MouseEvent) => void;
  onMouseLeave: () => void;
  onFocus: (event: FocusEvent) => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

const Tooltip: Component<TooltipProps> = (props) => {
  const [local] = splitProps(props, ['content', 'children']);
  const [isVisible, setIsVisible] = createSignal(false);
  const [placement, setPlacement] = createSignal<'above' | 'below'>('above');
  const [tooltipId] = createSignal(`tooltip-${crypto.randomUUID()}`);
  let triggerEl: HTMLElement | undefined;
  let enterTimeout: ReturnType<typeof setTimeout> | undefined;
  let leaveTimeout: ReturnType<typeof setTimeout> | undefined;

  const showTooltipImmediate = (event?: Event) => {
    if (event?.currentTarget instanceof HTMLElement) {
      triggerEl = event.currentTarget;
    }
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

  const showTooltipDelayed = (event: MouseEvent) => {
    triggerEl = event.currentTarget as HTMLElement;
    clearTimeout(enterTimeout);
    clearTimeout(leaveTimeout);
    enterTimeout = setTimeout(() => {
      showTooltipImmediate();
    }, 150);
  };

  const hideTooltip = () => {
    clearTimeout(enterTimeout);
    clearTimeout(leaveTimeout);
    setIsVisible(false);
  };

  const hideTooltipDelayed = () => {
    clearTimeout(enterTimeout);
    clearTimeout(leaveTimeout);
    leaveTimeout = setTimeout(hideTooltip, 100);
  };

  const keepTooltipVisible = () => {
    clearTimeout(leaveTimeout);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && isVisible()) {
      hideTooltip();
    }
  };

  onCleanup(() => {
    clearTimeout(enterTimeout);
    clearTimeout(leaveTimeout);
    triggerEl = undefined;
  });

  const tooltipClass = () => (placement() === 'above' ? 'bottom-full mb-1' : 'top-full mt-1');

  const arrowClass = () => (placement() === 'above' ? '-bottom-1' : '-top-1');

  const triggerProps: TooltipTriggerProps = {
    'aria-describedby': tooltipId(),
    onMouseEnter: showTooltipDelayed,
    onMouseLeave: hideTooltipDelayed,
    onFocus: showTooltipImmediate,
    onBlur: hideTooltip,
    onKeyDown: handleKeyDown,
  };

  return (
    <div class="relative inline-block">
      {local.children(triggerProps)}
      <Show when={isVisible()}>
        <div
          id={tooltipId()}
          class={`absolute ${TOOLTIP_Z_INDEX} px-3 py-2 text-xs text-text-primary bg-bg-elevated rounded-lg shadow-lg ${tooltipClass()} left-1/2 -translate-x-1/2 w-max max-w-[240px] whitespace-normal`}
          role="tooltip"
          onMouseEnter={keepTooltipVisible}
          onMouseLeave={hideTooltip}
        >
          {local.content}
          <div
            class={`absolute ${TOOLTIP_ARROW_SIZE} bg-bg-elevated rotate-45 left-1/2 -translate-x-1/2 ${arrowClass()}`}
          />
        </div>
      </Show>
    </div>
  );
};

export default Tooltip;
