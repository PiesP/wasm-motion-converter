// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { VP8_FOURCC, VP8X_FOURCC } from '@utils/constants';

const RIFF_MAGIC = 0x52494646;
const WEBP_MAGIC = 0x57454250;

function extractVp8Chunk(webpBuffer: Uint8Array): Uint8Array {
  if (webpBuffer.length < 24) {
    throw new Error(`WebP too small: ${webpBuffer.length} bytes (minimum 24)`);
  }

  const view = new DataView(webpBuffer.buffer, webpBuffer.byteOffset, webpBuffer.byteLength);
  if (view.getUint32(0, false) !== RIFF_MAGIC) {
    throw new Error(`Invalid RIFF header: 0x${view.getUint32(0, false).toString(16)}`);
  }
  if (view.getUint32(8, false) !== WEBP_MAGIC) {
    throw new Error(`Invalid WEBP type: 0x${view.getUint32(8, false).toString(16)}`);
  }

  const fourCC = view.getUint32(12, false);
  if (fourCC === VP8_FOURCC) {
    const frameSize = view.getUint32(16, true);
    if (20 + frameSize > webpBuffer.length) {
      throw new Error(`Frame size ${frameSize} exceeds buffer ${webpBuffer.length}`);
    }
    return webpBuffer.subarray(20, 20 + frameSize);
  }

  if (fourCC === VP8X_FOURCC) {
    const vp8xSize = view.getUint32(16, true);
    let offset = 20 + vp8xSize;
    while (offset + 8 <= webpBuffer.length) {
      const chunkFourCC = view.getUint32(offset, false);
      const chunkSize = view.getUint32(offset + 4, true);
      if (chunkFourCC === VP8_FOURCC) {
        if (offset + 8 + chunkSize > webpBuffer.length) {
          throw new Error(`VP8 chunk size ${chunkSize} exceeds buffer ${webpBuffer.length}`);
        }
        return webpBuffer.subarray(offset + 8, offset + 8 + chunkSize);
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    throw new Error('VP8X container does not contain a VP8 chunk');
  }

  const codec = String.fromCharCode(
    webpBuffer[12]!,
    webpBuffer[13]!,
    webpBuffer[14]!,
    webpBuffer[15]!
  );
  throw new Error(`Unknown WebP format: "${codec}" (0x${fourCC.toString(16)})`);
}

/**
 * Extract a Canvas-produced VP8 frame and normalize Chromium's keyframe
 * version/show-frame bits for use in an animated WebP ANMF chunk.
 */
export function extractAndNormalizeCanvasVp8(webpBuffer: Uint8Array): Uint8Array {
  const vp8Data = extractVp8Chunk(webpBuffer);
  let tagOffset = -1;
  for (let index = 0; index < Math.min(vp8Data.length - 2, 16); index++) {
    if (vp8Data[index] === 0x9d && vp8Data[index + 1] === 0x01 && vp8Data[index + 2] === 0x2a) {
      tagOffset = index;
      break;
    }
  }

  if (tagOffset < 0) return vp8Data;

  const frame = new Uint8Array(vp8Data);
  const keyframeIndex = tagOffset + 3;
  const keyframeByte = frame[keyframeIndex];
  if (keyframeByte !== undefined) {
    frame[keyframeIndex] = (keyframeByte & 0x8f) | 0x08;
  }
  return frame;
}
