import type { Component, ParentProps } from 'solid-js';

interface PanelProps extends ParentProps {
  class?: string;
  role?: 'region' | 'group' | 'presentation' | 'status' | 'alert';
  ariaLabel?: string;
  ariaLive?: 'polite' | 'assertive' | 'off';
  ariaBusy?: boolean;
}

const Panel: Component<PanelProps> = (props) => {
  return (
    <div
      class={`bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg ${props.class ?? ''}`.trim()}
      role={props.role}
      aria-label={props.ariaLabel}
      aria-live={props.ariaLive}
      aria-busy={props.ariaBusy}
    >
      {props.children}
    </div>
  );
};

export default Panel;
