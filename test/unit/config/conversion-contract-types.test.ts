import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const project = resolve(import.meta.dirname, '../../..');
const compiler = join(project, 'node_modules/typescript/bin/tsc');
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
export const decoderOmitted = { width: 8, height: 8 } satisfies DecodeOptions;
export const decoderUndefined = { ...decoderOmitted, mode: undefined,
  onFrameAvailable: undefined, onVideoFrameAvailable: undefined,
} satisfies DecodeOptions;
// The legacy public API remains permissive; invalid stream delivery is checked at runtime.
export const decoderStreamWithoutCallback = { ...decoderOmitted, mode: 'stream' } satisfies DecodeOptions;
export const decoderMixedBatch = { ...decoderOmitted, mode: 'batch',
  onFrameAvailable: (pixels) => { void pixels; },
  onVideoFrameAvailable: async (frame) => { frame.close(); },
} satisfies DecodeOptions;
`;

describe('conversion boundary type contracts', () => {
  it('accepts compatible conversion/decoder contracts and rejects invalid handoffs', () => {
    const root = mkdtempSync(join(project, '.conversion-types-'));
    try {
      const source = join(root, 'control.ts');
      const config = join(root, 'tsconfig.json');
      writeFileSync(
        config,
        JSON.stringify({
          extends: '../tsconfig.json',
          compilerOptions: { tsBuildInfoFile: './control.tsbuildinfo' },
          include: ['control.ts', '../src/**/*.d.ts'],
          exclude: [],
        })
      );
      const run = (suffix = '') => {
        writeFileSync(source, contract + suffix);
        return spawnSync(process.execPath, [compiler, '-p', config, '--noEmit'], {
          cwd: project,
          encoding: 'utf8',
          timeout: 20_000,
        });
      };
      const valid = run();
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      for (const [suffix, diagnostic] of [
        [
          "export const invalid = { ...decoderOmitted, mode: 'unknown' } satisfies DecodeOptions;",
          /TS2322/,
        ],
        [
          'export const invalid = { ...decoderOmitted, onVideoFrameAvailable: (frame: Uint8Array) => {} } satisfies DecodeOptions;',
          /TS2322/,
        ],
        [
          'export const invalid = { ...blobStart, inputBuffer: new ArrayBuffer(8) } satisfies WorkerRequest;',
          /TS2322: Type 'ArrayBuffer' is not assignable to type 'undefined'/,
        ],
        [
          "export const invalid = { type: 'start', requestId: 'missing', config, options } satisfies WorkerRequest;",
          /TS1360/,
        ],
      ] as const) {
        const invalid = run(suffix);
        expect(invalid.status).not.toBe(0);
        expect(invalid.stdout).toMatch(diagnostic);
      }
      const unvalidated = run(
        'export function invalid(event: MessageEvent<unknown>) { return event.data.type; }'
      );
      expect(unvalidated.status).not.toBe(0);
      expect(unvalidated.stdout).toContain('TS18046');
      const wrongProgress = run(
        'export const invalid: ProgressCallback = (_update: { progress: string }) => {};'
      );
      expect(wrongProgress.status).not.toBe(0);
      expect(wrongProgress.stdout).toContain('TS2322');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
