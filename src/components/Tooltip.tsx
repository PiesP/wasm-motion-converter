import type { Component, JSX } from 'solid-js';
import { createSignal, Show } from 'solid-js';

/**
 * Z-index for tooltip overlay
 */
const TOOLTIP_Z_INDEX = 'z-10';

/**
 * Tooltip vertical offset from trigger element
 */
const TOOLTIP_OFFSET_TOP = '-top-10';

/**
 * Arrow size for tooltip pointer
 */
const TOOLTIP_ARROW_SIZE = 'w-2 h-2';

/**
 * Tooltip component props
 */
interface TooltipProps {
  /** Tooltip text content */
  content: string;
  /** Child element that triggers the tooltip */
  children: JSX.Element;
}

/**
 * Tooltip component
 *
 * Displays a tooltip with content when user hovers or focuses on the child element.
 * The tooltip appears above the trigger element with a centered arrow pointer.
 * Supports both mouse and keyboard interactions for accessibility.
 *
 * @param props - Component props
 * @returns Tooltip wrapper with trigger and content
 */
const Tooltip: Component<TooltipProps> = (props) => {
  const [show, setShow] = createSignal<boolean>(false);

  return (
    <div class="relative inline-block">
      <div
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
      >
        {props.children}
      </div>
      <Show when={show()}>
        <div
          class={`absolute ${TOOLTIP_Z_INDEX} px-3 py-2 text-xs text-white bg-gray-900 dark:bg-gray-700 rounded-lg shadow-lg ${TOOLTIP_OFFSET_TOP} left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none`}
          role="tooltip"
        >
          {props.content}
          <div
            class={`absolute ${TOOLTIP_ARROW_SIZE} bg-gray-900 dark:bg-gray-700 rotate-45 left-1/2 -translate-x-1/2 -bottom-1`}
          />
        </div>
      </Show>
    </div>
  );
};

export default Tooltip;
