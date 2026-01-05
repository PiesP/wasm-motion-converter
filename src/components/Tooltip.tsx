import { createSignal, Show, type Component, type JSX } from 'solid-js';

interface TooltipProps {
  content: string;
  children: JSX.Element;
}

const Tooltip: Component<TooltipProps> = (props) => {
  const [show, setShow] = createSignal(false);

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
          class="absolute z-10 px-3 py-2 text-xs text-white bg-gray-900 dark:bg-gray-700 rounded-lg shadow-lg -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none"
          role="tooltip"
        >
          {props.content}
          <div class="absolute w-2 h-2 bg-gray-900 dark:bg-gray-700 rotate-45 left-1/2 -translate-x-1/2 -bottom-1" />
        </div>
      </Show>
    </div>
  );
};

export default Tooltip;
