export type ErrorCode =
  | 'CODEC_NOT_SUPPORTED'
  | 'OUT_OF_MEMORY'
  | 'DECODER_ERROR'
  | 'ENCODER_ERROR'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'CORRUPT_OUTPUT'
  | 'UNKNOWN';

export interface ClassifiedError {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
  suggestion: string;
}

/** 오류 분류 — 단일 계층, 구조화된 결과 */
export function classifyError(err: unknown): ClassifiedError {
  const msg = err instanceof Error ? err.message : String(err);

  if (err instanceof DOMException && err.name === 'AbortError') {
    return { code: 'CANCELLED', message: 'Conversion cancelled', recoverable: false, suggestion: '' };
  }

  if (msg.includes('NotSupportedError') || msg.includes('codec')) {
    return { code: 'CODEC_NOT_SUPPORTED', message: msg, recoverable: true, suggestion: 'Try a different video format or use the CPU fallback path.' };
  }

  if (msg.includes('memory') || msg.includes('OOM') || msg.includes('allocation')) {
    return { code: 'OUT_OF_MEMORY', message: msg, recoverable: true, suggestion: 'Reduce video resolution, quality, or close other tabs.' };
  }

  if (msg.includes('decode') || msg.includes('decoder')) {
    return { code: 'DECODER_ERROR', message: msg, recoverable: true, suggestion: 'Try the CPU fallback path.' };
  }

  if (msg.includes('encode') || msg.includes('encoder') || msg.includes('webp') || msg.includes('gif')) {
    return { code: 'ENCODER_ERROR', message: msg, recoverable: false, suggestion: 'Try adjusting quality settings.' };
  }

  return { code: 'UNKNOWN', message: msg, recoverable: false, suggestion: 'Please try a different video file.' };
}

/** 출력 파일 유효성 검증 */
export function validateOutput(output: Uint8Array, format: 'gif' | 'webp'): boolean {
  if (output.length < 50) return false;

  if (format === 'gif') {
    const header = new TextDecoder().decode(output.slice(0, 6));
    if (header !== 'GIF89a' && header !== 'GIF87a') return false;
    if (output[output.length - 1] !== 0x3B) return false;
  } else {
    const riff = new TextDecoder().decode(output.slice(0, 4));
    const webp = new TextDecoder().decode(output.slice(8, 12));
    if (riff !== 'RIFF' || webp !== 'WEBP') return false;
    const expectedSize = new DataView(output.buffer, output.byteOffset, output.byteLength).getUint32(4, true) + 8;
    if (output.length !== expectedSize) return false;
  }

  return true;
}
