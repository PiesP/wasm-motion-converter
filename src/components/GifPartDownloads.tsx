// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import Button from '@components/ui/Button';
import { useLocale } from '@hooks/use-locale';
import type { GifPartIndexedDbSink } from '@services/gif-part-indexed-db-sink';
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
};

interface GifPartDownloadsProps {
  storage: GifPartIndexedDbSink;
  busy: boolean;
  continuousGif?: boolean;
  onDiscard: () => void;
}

export default function GifPartDownloads(props: GifPartDownloadsProps) {
  const { t } = useLocale();
  const [prepared, setPrepared] = createSignal<{ filename: string; url: string }>();
  const [pending, setPending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [saved, setSaved] = createSignal<string>();
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  const usesSavePicker = () => props.continuousGif === true && typeof picker === 'function';
  const [discardStarted, setDiscardStarted] = createSignal(false);
  let reader: AbortController | undefined;
  let alive = true;

  const release = (): void => {
    reader?.abort();
    const current = prepared();
    if (current) URL.revokeObjectURL(current.url);
    setPrepared(undefined);
  };
  createEffect(() => {
    if (props.busy) release();
  });
  onCleanup(() => {
    alive = false;
    release();
  });

  const prepare = async (filename: string): Promise<void> => {
    if (pending() || props.busy || discardStarted()) return;
    release();
    setFailed(false);
    setSaved(undefined);
    setPending(true);
    const controller = new AbortController();
    reader = controller;
    try {
      // Open the picker in the user's click before awaiting OPFS.
      const target =
        props.continuousGif && typeof picker === 'function'
          ? await picker.call(window, { suggestedName: filename })
          : null;
      controller.signal.throwIfAborted();
      const blob = await props.storage.read(filename, controller.signal);
      controller.signal.throwIfAborted();
      if (target) {
        const destination = await target.createWritable();
        await blob.stream().pipeTo(destination, { signal: controller.signal });
        if (alive) setSaved(filename);
      } else {
        setPrepared({ filename, url: URL.createObjectURL(blob) });
      }
    } catch (error) {
      if (
        alive &&
        !controller.signal.aborted &&
        !(error instanceof DOMException && error.name === 'AbortError')
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

  const heading = () =>
    t(props.continuousGif ? 'result.convertedAnimation' : 'result.gifPartDownloads');

  return (
    <section class="mt-6 space-y-3" aria-busy={pending()} aria-label={heading()}>
      <h2 class="text-base font-semibold">{heading()}</h2>
      <ul class="space-y-2">
        <For each={discardStarted() ? [] : props.storage.files()}>
          {(file) => (
            <li>
              <Button
                variant="ghost"
                class="max-w-full break-all"
                disabled={pending() || props.busy}
                onClick={() => void prepare(file.filename)}
                data-testid="prepare-gif-part-download"
              >
                {t(usesSavePicker() ? 'result.downloadGifPart' : 'result.prepareGifPart', {
                  filename: file.filename,
                })}
              </Button>
              <Show when={prepared()?.filename === file.filename && prepared()} keyed>
                {(download) => (
                  <a
                    class="ml-2 inline-flex min-h-target-minimum items-center break-all font-medium text-brand underline"
                    href={download.url}
                    download={download.filename}
                    data-testid="download-gif-part"
                  >
                    {t('result.downloadGifPart', { filename: file.filename })}
                  </a>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
      <div>
        <Button
          variant="ghost"
          disabled={pending() || props.busy}
          onClick={() => void discard()}
          data-testid="discard-gif-parts"
        >
          {t(props.continuousGif ? 'update.clearResults' : 'result.discardGifParts')}
        </Button>
      </div>
      <Show when={saved()} keyed>
        {(filename) => <p role="status">{t('result.continuousGifSaved', { filename })}</p>}
      </Show>
      <Show when={failed()}>
        <p role="alert" class="text-status-danger">
          {t('error.gifPartsStorageFailed')}
        </p>
      </Show>
    </section>
  );
}
