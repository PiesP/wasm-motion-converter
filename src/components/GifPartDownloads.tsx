// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import Button from '@components/ui/Button';
import { useLocale } from '@hooks/use-locale';
import type { GifPartOpfsSink } from '@services/gif-part-opfs-sink';
import { createEffect, createSignal, onCleanup, Show } from 'solid-js';

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
};

interface GifPartDownloadsProps {
  storage: Pick<GifPartOpfsSink, 'filename' | 'read' | 'dispose'>;
  busy: boolean;
  onDiscard: () => void;
}

export default function GifPartDownloads(props: GifPartDownloadsProps) {
  const { t } = useLocale();
  const filename = props.storage.filename;
  const [prepared, setPrepared] = createSignal<string>();
  const [pending, setPending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [saved, setSaved] = createSignal<string>();
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  const selectTarget = typeof picker === 'function' ? picker : undefined;
  const [discardStarted, setDiscardStarted] = createSignal(false);
  let reader: AbortController | undefined;
  let alive = true;

  const release = (): void => {
    reader?.abort();
    const current = prepared();
    if (current) URL.revokeObjectURL(current);
    setPrepared(undefined);
  };
  createEffect(() => {
    // The chosen destination belongs to the save until its writer settles.
    if (!selectTarget && props.busy) release();
  });
  onCleanup(() => {
    alive = false;
    release();
  });

  const prepare = async (): Promise<void> => {
    if (pending() || props.busy || discardStarted()) return;
    release();
    setFailed(false);
    setSaved(undefined);
    setPending(true);
    const controller = new AbortController();
    reader = controller;
    let pickerPending = selectTarget !== undefined;
    try {
      // Open the picker in the user's click before awaiting OPFS.
      const target = selectTarget
        ? await selectTarget.call(window, { suggestedName: filename })
        : null;
      pickerPending = false;
      controller.signal.throwIfAborted();
      const file = await props.storage.read(controller.signal);
      controller.signal.throwIfAborted();
      if (target) {
        const destination = await target.createWritable();
        await file.stream().pipeTo(destination, { signal: controller.signal });
        if (alive) setSaved(target.name);
      } else {
        setPrepared(URL.createObjectURL(file));
      }
    } catch (error) {
      if (
        alive &&
        !controller.signal.aborted &&
        !(pickerPending && error instanceof DOMException && error.name === 'AbortError')
      )
        setFailed(true);
    } finally {
      reader = undefined;
      if (alive) setPending(false);
    }
  };

  const discard = async (): Promise<void> => {
    if (pending() || props.busy) return;
    release();
    setFailed(false);
    setPending(true);
    setDiscardStarted(true);
    try {
      await props.storage.dispose();
      if (alive) props.onDiscard();
    } catch {
      if (alive) setFailed(true);
    } finally {
      if (alive) setPending(false);
    }
  };

  const heading = () => t('result.convertedAnimation');

  return (
    <section class="mt-6 space-y-3" aria-busy={pending()} aria-label={heading()}>
      <h2 class="text-base font-semibold">{heading()}</h2>
      <Show when={!discardStarted()}>
        <div>
          <Button
            variant="ghost"
            class="max-w-full break-all"
            disabled={pending() || props.busy}
            onClick={() => void prepare()}
            data-testid="prepare-gif-part-download"
          >
            {t(selectTarget ? 'result.downloadGifPart' : 'result.prepareGifPart', { filename })}
          </Button>
          <Show when={prepared()} keyed>
            {(url) => (
              <a
                class="ml-2 inline-flex min-h-target-minimum items-center break-all font-medium text-brand underline"
                href={url}
                download={filename}
                data-testid="download-gif-part"
              >
                {t('result.downloadGifPart', { filename })}
              </a>
            )}
          </Show>
        </div>
      </Show>
      <div>
        <Button
          variant="ghost"
          disabled={pending() || props.busy}
          onClick={() => void discard()}
          data-testid="discard-gif-parts"
        >
          {t('update.clearResults')}
        </Button>
      </div>
      <Show when={saved()} keyed>
        {(name) => <p role="status">{t('result.continuousGifSaved', { filename: name })}</p>}
      </Show>
      <Show when={failed()}>
        <p role="alert" class="text-status-danger">
          {t('error.gifPartsStorageFailed')}
        </p>
      </Show>
    </section>
  );
}
