// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { Component, JSX } from 'solid-js';
import { createSignal, onCleanup, Show, splitProps } from 'solid-js';

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
  const [tooltipId] = createSignal(`tooltip-${crypto.randomUUID()}`);
  const anchorName = `--${tooltipId()}`;
  let enterTimeout: ReturnType<typeof setTimeout> | undefined;
  let leaveTimeout: ReturnType<typeof setTimeout> | undefined;

  const showTooltipImmediate = () => {
    setIsVisible(true);
  };

  const showTooltipDelayed = () => {
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
  });

  const triggerProps: TooltipTriggerProps = {
    'aria-describedby': tooltipId(),
    onMouseEnter: showTooltipDelayed,
    onMouseLeave: hideTooltipDelayed,
    onFocus: showTooltipImmediate,
    onBlur: hideTooltip,
    onKeyDown: handleKeyDown,
  };

  return (
    <div class="inline-block" style={{ 'anchor-name': anchorName }}>
      {local.children(triggerProps)}
      <Show when={isVisible()}>
        <div
          id={tooltipId()}
          class="anchored-tooltip z-10 w-max rounded-lg bg-bg-elevated px-3 py-2 text-xs text-text-primary shadow-lg whitespace-normal"
          style={{ 'position-anchor': anchorName }}
          role="tooltip"
          onMouseEnter={keepTooltipVisible}
          onMouseLeave={hideTooltip}
        >
          {local.content}
        </div>
      </Show>
    </div>
  );
};

export default Tooltip;
