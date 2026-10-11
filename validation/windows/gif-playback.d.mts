// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export type GifPlaybackMarker = 'red' | 'lime' | 'blue';

export interface GifPlaybackFrame {
  sequence: number;
  timestampMs: number | null;
  receivedEpochMs: number;
  file: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  rgb: number[];
  marker: GifPlaybackMarker | null;
}

export interface GifPlaybackAnalysis {
  errors: string[];
  runs: Array<{
    marker: GifPlaybackMarker;
    startMs: number;
    lastMs: number;
    firstSequence: number;
    lastSequence: number;
  }>;
  transitions: Array<{
    from: GifPlaybackMarker;
    to: GifPlaybackMarker;
    timestampMs: number;
    gapMs: number;
  }>;
  cycles: Array<{
    startMs: number;
    endMs: number;
    durationMs: number;
    holdsMs: number[];
  }>;
  incompleteLead: GifPlaybackMarker[];
  incompleteTail: GifPlaybackMarker[];
}

export interface GifPlaybackObservation {
  schemaVersion: 1;
  label: string;
  sourceSha256: string;
  sourceBytes: number;
  browserIdentity: { version: string | null; userAgent: string | null };
  method: 'headed-normal-img-cdp-png-screencast';
  capturePolicy: {
    captureMs: 2000;
    maxFrames: 256;
    everyNthFrame: 1;
    maxSampleGapMs: 35;
    maxCycleErrorMs: 35;
    maxMedianCycleErrorMs: 20;
    minCompleteCycles: 3;
  };
  rawGceDelaysCs: number[];
  frameRecords: GifPlaybackFrame[];
  visibility: Array<{
    wallEpochMs: number;
    visibilityState: string;
    hasFocus: boolean;
    imageSrcAssigned: boolean;
    imageComplete: boolean;
    naturalWidth: number;
    naturalHeight: number;
    imageCenterVisible: boolean;
  }>;
  visibilityEvents: Array<{ visible: boolean; wallEpochMs: number }>;
  overflow: boolean;
  captureEventCount: number;
  errors: string[];
  cleanupErrors: string[];
  analysis: GifPlaybackAnalysis;
  status: 'collected' | 'inconclusive';
}

export interface GifPlaybackArtifact {
  kind: 'gif-playback-frame' | 'gif-playback-observation';
  file: string;
  bytes: number;
  sha256: string;
}

export function parseGifDelaysCs(bytes: Uint8Array): number[];
export function inspectPlaybackPng(bytes: Buffer): {
  width: number;
  height: number;
  rgb: number[];
  marker: GifPlaybackMarker | null;
};
export function analyzeGifPlaybackFrames(
  frames: Array<Pick<GifPlaybackFrame, 'sequence' | 'timestampMs' | 'marker'>>
): GifPlaybackAnalysis;
export function collectGifPlayback(options: {
  context: import('@playwright/test').BrowserContext;
  gifBytes: Uint8Array;
  outputRoot: string;
  artifacts: GifPlaybackArtifact[];
  label: string;
}): Promise<GifPlaybackObservation>;
export function assertGifPlayback(
  observation: GifPlaybackObservation,
  options?: { expectedCycleMs?: number }
): GifPlaybackObservation;
