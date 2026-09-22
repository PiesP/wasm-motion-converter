export interface OutputContractCase {
  id: string;
  fixture: string;
  format: 'gif' | 'webp';
  sourceRotationClockwise?: number;
  settings: {
    quality: 'low' | 'medium' | 'high';
    scale: '0.5' | '0.75' | '1';
    trimStart: number;
    trimEnd: number;
    smartFrameSkip: 'off' | 'low' | 'medium' | 'high' | 'adaptive';
  };
  expected: {
    width: number;
    height: number;
    markers: string[];
    corners?: {
      topLeft: string;
      topRight: string;
      bottomLeft: string;
      bottomRight: string;
    };
    durationsMs: number[];
    durationToleranceMs: number;
    maxColorDistance: number;
  };
}

export interface AnimatedOutputObservation {
  frameCount: number;
  repetitionCount: number;
  frames: Array<{
    width: number;
    height: number;
    durationMs: number;
    complete: boolean;
    rgb: number[];
    marker: string | null;
    markerDistance: number;
    corners: Record<
      'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight',
      { rgb: number[]; marker: string | null; markerDistance: number }
    >;
  }>;
}

export function inspectAnimatedOutput(
  page: import('@playwright/test').Page,
  bytes: Uint8Array,
  format: OutputContractCase['format'],
  markers: Record<string, number[]>
): Promise<AnimatedOutputObservation>;

export function assertAnimatedOutput(
  observation: AnimatedOutputObservation,
  contract: OutputContractCase
): AnimatedOutputObservation;

export function verifyAnimatedOutput(
  page: import('@playwright/test').Page,
  bytes: Uint8Array,
  contract: OutputContractCase,
  markers: Record<string, number[]>
): Promise<AnimatedOutputObservation>;
