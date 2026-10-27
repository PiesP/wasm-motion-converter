import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const project = resolve(import.meta.dirname, '../../..');
const checker = join(project, 'node_modules/vite-plus/bin/vp');
const contract = `
import { runPipelineWithFallback } from '@services/conversion-worker/main-thread-proxy';
import { isWorkerRequest, isWorkerResponse } from '@services/conversion-worker/guards';
import type { SerializedDecoderConfig, SerializedConversionOptions, WorkerRequest } from '@services/conversion-worker/types';
import type { ConversionRequest, ProgressCallback } from '@t/conversion-types';
import type { DecodeOptions } from '@services/decoder-service';

export const config = { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16,
  description: undefined, hardwareAcceleration: undefined, rotation: undefined,
} satisfies SerializedDecoderConfig;
export const options = { format: 'gif', quality: 'medium', fps: 30, scale: 1,
  trimStart: 0, trimEnd: 0, maxFrames: 100, maxOutputBytes: 1024,
  forceDecimation: undefined, memoryPressureCadenceRatio: undefined,
  smartFrameSkip: undefined, maxMemoryMB: undefined,
} satisfies SerializedConversionOptions;
export const onProgress: ProgressCallback = (update) => { console.log(update.progress); };
export const request = { inputBlob: new Blob(), fileName: 'video.mp4', format: 'webp',
  quality: 'medium', scale: 1, trimStart: 0, trimEnd: 0, maxMemoryMB: 512,
  maxFrames: undefined, forceDecimation: undefined,
} satisfies ConversionRequest;
// The legacy main-thread request may retain both sources; Worker starts are exclusive.
export const legacyRequest = { ...request, inputBuffer: new ArrayBuffer(8) } satisfies ConversionRequest;
export const blobStart = { type: 'start', requestId: 'blob', inputBlob: new Blob(), config, options } satisfies WorkerRequest;
export const bufferStart = { type: 'start', requestId: 'buffer', inputBuffer: new ArrayBuffer(8), config, options } satisfies WorkerRequest;
export function directPipeline() { return runPipelineWithFallback(new Blob(), config, options, onProgress); }
export function validatedResponse(event: MessageEvent<unknown>) {
  if (!isWorkerResponse(event.data)) return null;
  return event.data.type;
}
export function validatedRequest(event: MessageEvent<unknown>) {
  if (!isWorkerRequest(event.data)) return null;
  return event.data.requestId;
}
export const decoderBase = { width: 8, height: 8 };
export const decoderCpu = { ...decoderBase,
  onFrameAvailable: (pixels: Uint8Array) => { void pixels; },
} satisfies DecodeOptions;
export const decoderAsyncCpu = { ...decoderBase,
  onFrameAvailable: async (pixels: Uint8Array) => { void pixels; },
} satisfies DecodeOptions;
`;

describe('conversion boundary type contracts', () => {
  it('accepts compatible conversion/decoder contracts and rejects invalid handoffs', () => {
    const root = mkdtempSync(join(project, 'node_modules/conversion-types-'));
    try {
      const source = join(root, 'probe.ts');
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          extends: '../../src/tsconfig.json',
          include: ['probe.ts', '../../src/**/*.d.ts'],
        })
      );
      const run = (suffix = '') => {
        writeFileSync(source, contract + suffix);
        return spawnSync(process.execPath, [checker, 'check', '--no-fmt', '--no-lint', source], {
          cwd: project,
          encoding: 'utf8',
          timeout: 20_000,
        });
      };
      const valid = run();
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      const invalidCases = [
        'export const invalidDecoderMissing = decoderBase satisfies DecodeOptions;',
        'export const invalidDecoderUndefined = { ...decoderBase, onFrameAvailable: undefined } satisfies DecodeOptions;',
        "export const invalidDecoderMode = { ...decoderCpu, mode: 'batch' } satisfies DecodeOptions;",
        'export const invalidDecoderCallback = { ...decoderCpu, onVideoFrameAvailable: (frame: VideoFrame) => frame.close() } satisfies DecodeOptions;',
        'export const invalidWorkerHandoff = { ...blobStart, inputBuffer: new ArrayBuffer(8) } satisfies WorkerRequest;',
        "export const invalidWorkerMissingSource = { type: 'start', requestId: 'missing', config, options } satisfies WorkerRequest;",
        'export function invalidUnvalidated(event: MessageEvent<unknown>) { return event.data.type; }',
        'export const invalidProgress: ProgressCallback = (_update: { progress: string }) => {};',
      ];
      const invalid = run(invalidCases.join('\n'));
      expect(invalid.status).not.toBe(0);
      const firstInvalidLine = contract.split('\n').length;
      for (const index of invalidCases.keys()) {
        expect(invalid.stdout).toContain(`probe.ts:${firstInvalidLine + index}:`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
