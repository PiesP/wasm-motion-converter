// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { Component, JSX } from 'solid-js';
import { createSignal, Show, splitProps } from 'solid-js';

const TOOLTIP_Z_INDEX = 'z-10';
const TOOLTIP_OFFSET_TOP = '-top-10';
const TOOLTIP_ARROW_SIZE = 'w-2 h-2';

interface TooltipProps {
  content: string;
  children: JSX.Element;
}

/** Check if the Popover API is available (baseline 2025, all major browsers) */
const SUPPORTS_POPOVER = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;

const Tooltip: Component<TooltipProps> = (props) => {
  const [local] = splitProps(props, ['content', 'children']);
  const [isVisible, setIsVisible] = createSignal(false);
  const [tooltipId] = createSignal(`tooltip-${crypto.randomUUID()}`);
  const [isNativePopover, setIsNativePopover] = createSignal(false);

  const showTooltip = () => setIsVisible(true);
  const hideTooltip = () => setIsVisible(false);

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && isVisible()) {
      hideTooltip();
    }
  };

  // When Popover API is available, use it for light dismiss + ESC + top layer
  const initPopover = (el: HTMLDivElement) => {
    if (SUPPORTS_POPOVER && el) {
      (el as HTMLDivElement & { popover?: string }).popover = 'hint';
      setIsNativePopover(true);
    }
  };

  return (
    <div class="relative inline-block">
      <div
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        onKeyDown={handleKeyDown}
        aria-describedby={tooltipId()}
      >
        {local.children}
      </div>
      <Show when={isVisible() || isNativePopover()}>
        <div
          id={tooltipId()}
          ref={initPopover}
          class={`absolute ${TOOLTIP_Z_INDEX} px-3 py-2 text-xs text-[#f7f8f8] bg-[#191a1b] rounded-lg shadow-lg ${TOOLTIP_OFFSET_TOP} left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none`}
          role="tooltip"
        >
          {local.content}
          <div
            class={`absolute ${TOOLTIP_ARROW_SIZE} bg-[#191a1b] rotate-45 left-1/2 -translate-x-1/2 -bottom-1`}
          />
        </div>
      </Show>
    </div>
  );
};

export default Tooltip;
