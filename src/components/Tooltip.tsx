import { type Component, createSignal, type JSX, Show, splitProps } from 'solid-js';

const TOOLTIP_Z_INDEX = 'z-10';
const TOOLTIP_OFFSET_TOP = '-top-10';
const TOOLTIP_ARROW_SIZE = 'w-2 h-2';

interface TooltipProps {
  content: string;
  children: JSX.Element;
}

const Tooltip: Component<TooltipProps> = (props) => {
  const [local] = splitProps(props, ['content', 'children']);
  const [isVisible, setIsVisible] = createSignal(false);

  const showTooltip = () => setIsVisible(true);
  const hideTooltip = () => setIsVisible(false);

  return (
    <div class="relative inline-block">
      <div
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
      >
        {local.children}
      </div>
      <Show when={isVisible()}>
        <div
          class={`absolute ${TOOLTIP_Z_INDEX} px-3 py-2 text-xs text-white bg-gray-900 dark:bg-gray-700 rounded-lg shadow-lg ${TOOLTIP_OFFSET_TOP} left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none`}
          role="tooltip"
        >
          {local.content}
          <div
            class={`absolute ${TOOLTIP_ARROW_SIZE} bg-gray-900 dark:bg-gray-700 rotate-45 left-1/2 -translate-x-1/2 -bottom-1`}
          />
        </div>
      </Show>
    </div>
  );
};

export default Tooltip;
