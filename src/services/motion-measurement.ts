// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Task-only matched-build diagnostics; never enabled by an ordinary product build. */
export const motionMeasurementEnabled = import.meta.env.VITE_MOTION_MEASUREMENT === '1';
export type MotionDimensions = { width: number; height: number; stride: number };
const dimensions: MotionDimensions[] = [];
export function resetMotionMeasurements(): void {
  dimensions.length = 0;
}
export function recordMotionDimensions(width: number, height: number, stride: number): void {
  if (motionMeasurementEnabled) dimensions.push({ width, height, stride });
}
export function readMotionDimensions(): readonly MotionDimensions[] {
  return [...dimensions];
}
