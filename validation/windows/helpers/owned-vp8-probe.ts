// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Narrow browser VP8 encoding probe for #497; it does not change product routes. */
export type NativeVp8ProbeResult =
  | { status: 'unsupported'; stage: 'api' | 'configuration' | 'decoder' }
  | {
      status: 'encoded';
      actualConfig: VideoEncoderConfig;
      rawFrame: number[];
      frameType: EncodedVideoChunkType;
      decodedWidth: number;
      decodedHeight: number;
      decodedCodedWidth: number;
      decodedCodedHeight: number;
      encodedBytes: number;
    };

// Self-contained so Playwright can serialize it into an actual browser page.
export async function runOwnedVp8NativeProbe({
  rgba,
  width,
  height,
  bitrate = 800_000,
}: {
  rgba: number[];
  width: number;
  height: number;
  bitrate?: number;
}): Promise<NativeVp8ProbeResult> {
  async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} exceeded 10 seconds`)), 10_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 2048 ||
    height > 2048 ||
    !Number.isSafeInteger(bitrate) ||
    bitrate <= 0 ||
    rgba.length !== width * height * 4 ||
    !rgba.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)
  ) {
    throw new RangeError('Invalid VP8 probe pixels or dimensions');
  }
  if (
    typeof VideoEncoder === 'undefined' ||
    typeof VideoFrame === 'undefined' ||
    typeof EncodedVideoChunk === 'undefined'
  ) {
    return { status: 'unsupported', stage: 'api' };
  }
  const requested: VideoEncoderConfig = {
    codec: 'vp8',
    width,
    height,
    bitrate,
    framerate: 1,
    latencyMode: 'realtime',
  };
  const supported = await bounded(VideoEncoder.isConfigSupported(requested), 'VP8 support check');
  if (!supported.supported || !supported.config)
    return { status: 'unsupported', stage: 'configuration' };
  const copies: Uint8Array[] = [];
  const types: EncodedVideoChunkType[] = [];
  let encoderError: DOMException | undefined;
  const encoder = new VideoEncoder({
    output(chunk) {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      copies.push(bytes);
      types.push(chunk.type);
    },
    error(error) {
      encoderError = error;
    },
  });
  let frame: VideoFrame | undefined;
  try {
    encoder.configure(supported.config);
    frame = new VideoFrame(new Uint8Array(rgba), {
      format: 'RGBA',
      codedWidth: width,
      codedHeight: height,
      timestamp: 0,
    });
    encoder.encode(frame, { keyFrame: true });
    await bounded(encoder.flush(), 'VP8 encode');
    if (encoderError) throw encoderError;
    if (copies.length !== 1 || types[0] !== 'key') {
      throw new Error('VP8 probe did not return one keyframe');
    }
    const rawFrame = copies[0]!;
    if (
      rawFrame.byteLength < 10 ||
      (rawFrame[0]! & 1) !== 0 ||
      rawFrame[3] !== 0x9d ||
      rawFrame[4] !== 0x01 ||
      rawFrame[5] !== 0x2a ||
      ((rawFrame[6]! | (rawFrame[7]! << 8)) & 0x3fff) !== width ||
      ((rawFrame[8]! | (rawFrame[9]! << 8)) & 0x3fff) !== height
    ) {
      throw new Error('VP8 probe returned an incompatible keyframe payload');
    }
    if (typeof VideoDecoder === 'undefined') return { status: 'unsupported', stage: 'decoder' };
    const decoderSupport = await bounded(
      VideoDecoder.isConfigSupported({ codec: 'vp8', codedWidth: width, codedHeight: height }),
      'VP8 decode support check'
    );
    if (!decoderSupport.supported || !decoderSupport.config)
      return { status: 'unsupported', stage: 'decoder' };
    const decoded: Array<{
      width: number;
      height: number;
      codedWidth: number;
      codedHeight: number;
      visible: { x: number; y: number; width: number; height: number } | null;
    }> = [];
    let decoderError: DOMException | undefined;
    const decoder = new VideoDecoder({
      output(output) {
        const visible = output.visibleRect;
        decoded.push({
          width: output.displayWidth,
          height: output.displayHeight,
          codedWidth: output.codedWidth,
          codedHeight: output.codedHeight,
          visible: visible && {
            x: visible.x,
            y: visible.y,
            width: visible.width,
            height: visible.height,
          },
        });
        output.close();
      },
      error(error) {
        decoderError = error;
      },
    });
    try {
      decoder.configure(decoderSupport.config);
      decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: rawFrame }));
      await bounded(decoder.flush(), 'VP8 browser decode');
      if (decoderError) throw decoderError;
      // Coded storage may include padding; verify the VP8 header and visible/display extents.
      // https://www.w3.org/TR/webcodecs/#dom-videoframe-codedwidth
      const geometry = decoded[0];
      if (
        decoded.length !== 1 ||
        !geometry ||
        geometry.width !== width ||
        geometry.height !== height ||
        geometry.codedWidth < width ||
        geometry.codedHeight < height ||
        geometry.visible?.x !== 0 ||
        geometry.visible.y !== 0 ||
        geometry.visible.width !== width ||
        geometry.visible.height !== height
      ) {
        throw new Error(
          `VP8 browser decode returned incompatible geometry: ${JSON.stringify(decoded)}`
        );
      }
    } finally {
      decoder.close();
    }
    return {
      status: 'encoded',
      actualConfig: supported.config,
      rawFrame: Array.from(rawFrame),
      frameType: types[0]!,
      encodedBytes: rawFrame.byteLength,
      decodedWidth: decoded[0]!.width,
      decodedHeight: decoded[0]!.height,
      decodedCodedWidth: decoded[0]!.codedWidth,
      decodedCodedHeight: decoded[0]!.codedHeight,
    };
  } finally {
    frame?.close();
    encoder.close();
  }
}
