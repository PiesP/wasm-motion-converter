import { type Component, type ParentProps, splitProps } from 'solid-js';

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
    `bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg ${local.class ?? ''}`.trim();

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
