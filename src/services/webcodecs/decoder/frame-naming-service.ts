/**
 * Frame naming helper.
 */

export function formatFrameName(
  framePrefix: string,
  frameDigits: number,
  frameIndex: number,
  frameStartNumber: number,
  extension: string
): string {
  const frameNumber = frameStartNumber + frameIndex;
  const paddedNumber = frameNumber.toString().padStart(frameDigits, '0');
  return `${framePrefix}${paddedNumber}.${extension}`;
}
