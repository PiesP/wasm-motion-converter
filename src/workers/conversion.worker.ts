import { runConversionPipeline } from '../services/v2/conversion-pipeline';
import type { ConversionRequest, ConversionWorkerMessage } from '../types/v2-conversion-types';

let currentController: AbortController | null = null;

self.onmessage = async (e: MessageEvent<ConversionWorkerMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      break;
    }

    case 'convert': {
      const request: ConversionRequest = msg.request;
      currentController = new AbortController();

      try {
        const output = await runConversionPipeline(
          request,
          (progress) => {
            self.postMessage({ type: 'progress', progress });
          },
          currentController.signal
        );

        self.postMessage({ type: 'complete', output, format: request.format }, [output]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code =
          err instanceof DOMException && err.name === 'AbortError'
            ? 'CANCELLED'
            : 'CONVERSION_ERROR';
        self.postMessage({ type: 'error', message, code });
      }
      break;
    }

    case 'cancel': {
      currentController?.abort();
      break;
    }
  }
};
