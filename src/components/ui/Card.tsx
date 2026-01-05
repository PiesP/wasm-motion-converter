import { type Component, type JSX, splitProps } from 'solid-js';

export type CardVariant = 'default' | 'outlined' | 'elevated';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps extends JSX.HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: CardPadding;
}

const Card: Component<CardProps> = (props) => {
  const [local, others] = splitProps(props, ['variant', 'padding', 'class', 'children']);

  const variant = () => local.variant ?? 'default';
  const padding = () => local.padding ?? 'md';

  const baseClasses = 'rounded-lg';

  const variantClasses = () => {
    switch (variant()) {
      case 'default':
        return 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800';
      case 'outlined':
        return 'bg-transparent border-2 border-gray-300 dark:border-gray-700';
      case 'elevated':
        return 'bg-white dark:bg-gray-900 shadow-lg border border-gray-200 dark:border-gray-800';
      default:
        return '';
    }
  };

  const paddingClasses = () => {
    switch (padding()) {
      case 'none':
        return '';
      case 'sm':
        return 'p-3';
      case 'md':
        return 'p-6';
      case 'lg':
        return 'p-8';
      default:
        return '';
    }
  };

  const combinedClasses = () =>
    [baseClasses, variantClasses(), paddingClasses(), local.class].filter(Boolean).join(' ');

  return (
    <div {...others} class={combinedClasses()}>
      {local.children}
    </div>
  );
};

export default Card;
