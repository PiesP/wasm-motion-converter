import { createSignal, onMount, type Component } from 'solid-js';
import type { ConversionFormat } from '../types/conversion-types';
import { AVIFService } from '../services/avif-service';
import OptionSelector, { type OptionSelectorOption } from './OptionSelector';

interface FormatSelectorProps {
  value: ConversionFormat;
  onChange: (format: ConversionFormat) => void;
  disabled?: boolean;
}

const FormatSelector: Component<FormatSelectorProps> = (props) => {
  const [avifSupported, setAvifSupported] = createSignal(false);

  onMount(async () => {
    const supported = await AVIFService.isSupported();
    setAvifSupported(supported);
  });

  const options = (): OptionSelectorOption<ConversionFormat>[] => {
    const baseOptions: OptionSelectorOption<ConversionFormat>[] = [
      { value: 'gif', label: 'GIF', description: 'Universal support' },
      { value: 'webp', label: 'WebP', description: 'Smaller file size' },
    ];

    if (avifSupported()) {
      baseOptions.push({
        value: 'avif',
        label: 'AVIF ⭐',
        description: 'Premium quality',
      });
    }

    return baseOptions;
  };

  const columns = () => (avifSupported() ? 3 : 2);

  return (
    <OptionSelector
      title="Output Format"
      name="format"
      value={props.value}
      options={options()}
      onChange={props.onChange}
      disabled={props.disabled}
      columns={columns()}
    />
  );
};

export default FormatSelector;
