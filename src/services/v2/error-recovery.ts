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
    return {
      code: 'CANCELLED',
      message: 'Conversion cancelled',
      recoverable: false,
      suggestion: '',
    };
  }

  if (msg.includes('NotSupportedError') || msg.includes('codec')) {
    return {
      code: 'CODEC_NOT_SUPPORTED',
      message: msg,
      recoverable: true,
      suggestion: 'Try a different video format or use the CPU fallback path.',
    };
  }

  if (msg.includes('memory') || msg.includes('OOM') || msg.includes('allocation')) {
    return {
      code: 'OUT_OF_MEMORY',
      message: msg,
      recoverable: true,
      suggestion: 'Reduce video resolution, quality, or close other tabs.',
    };
  }

  if (msg.includes('decode') || msg.includes('decoder')) {
    return {
      code: 'DECODER_ERROR',
      message: msg,
      recoverable: true,
      suggestion: 'Try the CPU fallback path.',
    };
  }

  if (
    msg.includes('encode') ||
    msg.includes('encoder') ||
    msg.includes('webp') ||
    msg.includes('gif')
  ) {
    return {
      code: 'ENCODER_ERROR',
      message: msg,
      recoverable: false,
      suggestion: 'Try adjusting quality settings.',
    };
  }

  return {
    code: 'UNKNOWN',
    message: msg,
    recoverable: false,
    suggestion: 'Please try a different video file.',
  };
}

/** 출력 파일 유효성 검증 (헤더만 검사, 전체 파일 불필요) */
export function validateOutput(output: Uint8Array, format: 'gif' | 'webp'): boolean {
  // Minimum bytes needed: GIF=6 (header), WebP=12 (RIFF+size+WEBP)
  if (output.length < 6) return false;

  if (format === 'gif') {
    const header = new TextDecoder().decode(output.slice(0, 6));
    if (header !== 'GIF89a' && header !== 'GIF87a') return false;
    // Trailer byte (0x3b) check requires full file — skip for header-only validation
  } else {
    if (output.length < 12) return false;
    const riff = new TextDecoder().decode(output.slice(0, 4));
    const webp = new TextDecoder().decode(output.slice(8, 12));
    if (riff !== 'RIFF' || webp !== 'WEBP') return false;
    // Size check requires full file — skip for header-only validation
  }

  return true;
}
