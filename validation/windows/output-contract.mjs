// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

/** Decode every frame without discarding observations when a contract later fails. */
export async function inspectAnimatedOutput(page, bytes, format, markers) {
  return page.evaluate(
    async ({ encodedBytes, mimeType, markerColors }) => {
      if (typeof globalThis.ImageDecoder !== 'function') {
        throw new Error('ImageDecoder is unavailable in the contract browser');
      }
      const decoder = new ImageDecoder({
        data: new Uint8Array(encodedBytes),
        type: mimeType,
        preferAnimation: true,
      });
      try {
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        if (!track) throw new Error('Animated output has no selected image track');

        const frames = [];
        for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
          const decoded = await decoder.decode({ frameIndex, completeFramesOnly: true });
          const image = decoded.image;
          try {
            const classify = (rgb) => {
              const candidates = Object.entries(markerColors).map(([name, color]) => ({
                name,
                distance: Math.hypot(rgb[0] - color[0], rgb[1] - color[1], rgb[2] - color[2]),
              }));
              candidates.sort((left, right) => left.distance - right.distance);
              return {
                rgb,
                marker: candidates[0]?.name ?? null,
                markerDistance: candidates[0]?.distance ?? Number.POSITIVE_INFINITY,
              };
            };
            const averagePixels = (pixels) => {
              const average = [0, 0, 0];
              for (let offset = 0; offset < pixels.length; offset += 4) {
                average[0] += pixels[offset];
                average[1] += pixels[offset + 1];
                average[2] += pixels[offset + 2];
              }
              const pixelCount = pixels.length / 4;
              return average.map((channel) => Math.round(channel / pixelCount));
            };

            const averageCanvas = new OffscreenCanvas(8, 8);
            const averageContext = averageCanvas.getContext('2d', { willReadFrequently: true });
            if (!averageContext) throw new Error('Unable to sample decoded animation frame');
            averageContext.drawImage(image, 0, 0, averageCanvas.width, averageCanvas.height);
            const marker = classify(
              averagePixels(
                averageContext.getImageData(0, 0, averageCanvas.width, averageCanvas.height).data
              )
            );

            const spatialCanvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
            const spatialContext = spatialCanvas.getContext('2d', { willReadFrequently: true });
            if (!spatialContext) throw new Error('Unable to sample decoded frame orientation');
            spatialContext.drawImage(image, 0, 0);
            const sampleCorner = (x, y) =>
              classify(averagePixels(spatialContext.getImageData(x, y, 6, 6).data));
            const inset = 2;
            const farX = image.displayWidth - inset - 6;
            const farY = image.displayHeight - inset - 6;
            const corners = {
              topLeft: sampleCorner(inset, inset),
              topRight: sampleCorner(farX, inset),
              bottomLeft: sampleCorner(inset, farY),
              bottomRight: sampleCorner(farX, farY),
            };
            frames.push({
              width: image.displayWidth,
              height: image.displayHeight,
              durationMs: (image.duration ?? 0) / 1000,
              complete: decoded.complete,
              ...marker,
              corners,
            });
          } finally {
            image.close();
          }
        }
        return {
          frameCount: track.frameCount,
          repetitionCount: track.repetitionCount,
          frames,
        };
      } finally {
        decoder.close();
      }
    },
    {
      encodedBytes: [...bytes],
      mimeType: format === 'gif' ? 'image/gif' : 'image/webp',
      markerColors: markers,
    }
  );
}

/** Validate a retained observation independently of the conversion measurement. */
export function assertAnimatedOutput(observation, contract) {
  // Stored frames may be split or merged. Compare source-derived scene intervals.
  const scenes = [];
  for (const frame of observation.frames) {
    const prior = scenes[scenes.length - 1];
    if (prior?.marker === frame.marker) prior.durationMs += frame.durationMs;
    else scenes.push({ marker: frame.marker, durationMs: frame.durationMs });
  }
  assert.equal(scenes.length, contract.expected.markers.length, `${contract.id}: scene count`);
  assert.deepEqual(
    scenes.map((frame) => frame.marker),
    contract.expected.markers,
    `${contract.id}: frame marker order`
  );
  for (const [index, frame] of observation.frames.entries()) {
    assert.equal(frame.complete, true, `${contract.id}: frame ${index} did not decode completely`);
    assert.equal(frame.width, contract.expected.width, `${contract.id}: frame ${index} width`);
    assert.equal(frame.height, contract.expected.height, `${contract.id}: frame ${index} height`);
    assert(
      frame.markerDistance <= contract.expected.maxColorDistance,
      `${contract.id}: frame ${index} color ${frame.rgb.join(',')} is outside its marker tolerance`
    );
    if (contract.expected.corners) {
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(frame.corners).map(([corner, sample]) => [corner, sample.marker])
        ),
        contract.expected.corners,
        `${contract.id}: frame ${index} corner orientation`
      );
      for (const [corner, sample] of Object.entries(frame.corners)) {
        assert(
          sample.markerDistance <= contract.expected.maxColorDistance,
          `${contract.id}: frame ${index} ${corner} color ${sample.rgb.join(',')} is outside tolerance`
        );
      }
    }
  }
  let actualBoundaryMs = 0;
  let expectedBoundaryMs = 0;
  for (const [index, scene] of scenes.entries()) {
    actualBoundaryMs += scene.durationMs;
    expectedBoundaryMs += contract.expected.durationsMs[index];
    assert(
      Math.abs(actualBoundaryMs - expectedBoundaryMs) <= contract.expected.durationToleranceMs,
      `${contract.id}: scene ${index} boundary ${actualBoundaryMs}ms instead of ${expectedBoundaryMs}ms`
    );
  }
  assert(
    Math.abs(
      observation.frames.reduce((sum, frame) => sum + frame.durationMs, 0) -
        contract.expected.durationsMs.reduce((sum, duration) => sum + duration, 0)
    ) <= contract.expected.durationToleranceMs,
    `${contract.id}: total playback duration`
  );
  return observation;
}

/** Decode every animation frame in the target browser and validate the shared contract. */
export async function verifyAnimatedOutput(page, bytes, contract, markers) {
  return assertAnimatedOutput(
    await inspectAnimatedOutput(page, bytes, contract.format, markers),
    contract
  );
}

/** Prove that the first GIF image replaces the entire opaque logical screen at each loop. */
function gifLoopStartGeometry(bytes, label) {
  const fail = () => {
    throw new Error(`${label} GIF loop start is unsupported or incomplete`);
  };
  const u16 = (offset) => bytes[offset] | (bytes[offset + 1] << 8);
  if (
    bytes.length < 13 ||
    String.fromCharCode(...bytes.subarray(0, 3)) !== 'GIF' ||
    !['87a', '89a'].includes(String.fromCharCode(...bytes.subarray(3, 6)))
  )
    fail();
  const width = u16(6);
  const height = u16(8);
  if (width < 1 || height < 1) fail();
  const packed = bytes[10];
  let offset = 13 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
  if (offset > bytes.length) fail();
  let transparent = false;
  let sawControl = false;
  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 0x2c) {
      if (offset + 9 > bytes.length) fail();
      if (
        u16(offset) !== 0 ||
        u16(offset + 2) !== 0 ||
        u16(offset + 4) !== width ||
        u16(offset + 6) !== height ||
        transparent
      )
        fail();
      return { width, height };
    }
    if (block !== 0x21 || offset >= bytes.length) fail();
    const extension = bytes[offset++];
    if (extension === 0xf9) {
      if (sawControl || offset + 6 > bytes.length || bytes[offset] !== 4 || bytes[offset + 5] !== 0)
        fail();
      transparent = (bytes[offset + 1] & 1) !== 0;
      sawControl = true;
      offset += 6;
      continue;
    }
    // Plain text is a graphic-rendering block and can consume a control extension.
    if (extension !== 0xff && extension !== 0xfe) fail();
    while (true) {
      if (offset >= bytes.length) fail();
      const length = bytes[offset++];
      if (length === 0) break;
      if (offset + length > bytes.length) fail();
      offset += length;
    }
  }
  fail();
}

/** Prove the first WebP ANMF covers its canvas without depending on prior pixels. */
function webpLoopStartGeometry(bytes, label) {
  const fail = () => {
    throw new Error(`${label} WebP loop start is unsupported or incomplete`);
  };
  const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const u24 = (offset) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  const u32 = (offset) =>
    bytes[offset] +
    bytes[offset + 1] * 256 +
    bytes[offset + 2] * 65536 +
    bytes[offset + 3] * 16777216;
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP' || u32(4) + 8 !== bytes.length)
    fail();
  let offset = 12;
  let canvas = null;
  let sawAnimation = false;
  while (offset + 8 <= bytes.length) {
    const fourcc = tag(offset);
    const size = u32(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end + (size & 1) > bytes.length) fail();
    if (fourcc === 'VP8X') {
      if (canvas || sawAnimation || size < 10 || !(bytes[start] & 0x02)) fail();
      canvas = { width: u24(start + 4) + 1, height: u24(start + 7) + 1 };
    } else if (fourcc === 'ANIM') {
      if (!canvas || sawAnimation || size < 6) fail();
      sawAnimation = true;
    } else if (fourcc === 'ANMF') {
      if (!canvas || !sawAnimation || size < 16) fail();
      if (
        u24(start) !== 0 ||
        u24(start + 3) !== 0 ||
        u24(start + 6) + 1 !== canvas.width ||
        u24(start + 9) + 1 !== canvas.height
      )
        fail();
      // B=0 is safe only for an opaque VP8 image with no ALPH subchunk.
      // B=1 overwrites the full rectangle regardless of previous canvas state.
      if ((bytes[start + 15] & 0x02) === 0) {
        let child = start + 16;
        let sawVp8 = false;
        while (child + 8 <= end) {
          const childTag = tag(child);
          const childSize = u32(child + 4);
          const childEnd = child + 8 + childSize;
          if (childEnd + (childSize & 1) > end || childTag === 'ALPH' || childTag === 'VP8L')
            fail();
          if (childTag === 'VP8 ') sawVp8 = true;
          child = childEnd + (childSize & 1);
        }
        if (!sawVp8 || child !== end) fail();
      }
      return canvas;
    }
    offset = end + (size & 1);
  }
  fail();
}

/**
 * Compare decoded, fully composited output at every presentation change. This is
 * deliberately separate from the source-to-output marker tolerance above.
 * Duplicate frames, frame rectangles, palettes, and compressed bytes may differ.
 * The loop check is limited to opaque outputs whose first encoded frame fully
 * covers the canvas and cannot depend on the previous loop's pixels.
 */
export async function compareAnimatedOutputExact(
  page,
  referenceBytes,
  candidateBytes,
  referenceFormat,
  candidateFormat = referenceFormat
) {
  const maxInputBytes = 4 * 1024 * 1024;
  if (
    referenceBytes.length === 0 ||
    candidateBytes.length === 0 ||
    referenceBytes.length > maxInputBytes ||
    candidateBytes.length > maxInputBytes
  ) {
    throw new Error('Exact output comparison input exceeds its 4 MiB per-file budget');
  }
  if (!['gif', 'webp'].includes(referenceFormat) || !['gif', 'webp'].includes(candidateFormat)) {
    throw new Error('Unsupported exact output comparison format');
  }
  const referenceGeometry = (
    referenceFormat === 'gif' ? gifLoopStartGeometry : webpLoopStartGeometry
  )(referenceBytes, 'Reference');
  const candidateGeometry = (
    candidateFormat === 'gif' ? gifLoopStartGeometry : webpLoopStartGeometry
  )(candidateBytes, 'Candidate');

  return page.evaluate(
    async ({
      reference,
      candidate,
      referenceMimeType,
      candidateMimeType,
      referenceGeometry,
      candidateGeometry,
    }) => {
      const maxFrames = 240;
      const maxPixels = 1024 * 1024;
      const maxDecodedPixels = 32 * 1024 * 1024;
      const maxDurationUs = 120_000_000;
      if (typeof globalThis.ImageDecoder !== 'function') {
        throw new Error('ImageDecoder is unavailable in the contract browser');
      }

      const decoders = [];
      const open = async (bytes, mimeType, geometry, label) => {
        const decoder = new ImageDecoder({
          data: new Uint8Array(bytes),
          type: mimeType,
          preferAnimation: true,
        });
        decoders.push(decoder);
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        if (
          !track ||
          !Number.isInteger(track.frameCount) ||
          track.frameCount < 1 ||
          track.frameCount > maxFrames
        ) {
          throw new Error(`${label} frame count exceeds the exact comparison budget`);
        }
        return {
          decoder,
          track,
          label,
          geometry,
          nextIndex: 0,
          endUs: 0,
          decodedPixels: 0,
          pixels: null,
          canvas: null,
          context: null,
        };
      };

      try {
        const left = await open(reference, referenceMimeType, referenceGeometry, 'Reference');
        const right = await open(candidate, candidateMimeType, candidateGeometry, 'Candidate');
        if (!Object.is(left.track.repetitionCount, right.track.repetitionCount)) {
          throw new Error('Animated output loop count differs');
        }

        const readNext = async (side) => {
          if (side.nextIndex >= side.track.frameCount) return false;
          const { image, complete } = await side.decoder.decode({
            frameIndex: side.nextIndex++,
            completeFramesOnly: true,
          });
          try {
            if (!complete) throw new Error(`${side.label} frame did not decode completely`);
            const { displayWidth: width, displayHeight: height, duration } = image;
            if (
              !Number.isInteger(width) ||
              !Number.isInteger(height) ||
              width < 1 ||
              height < 1 ||
              width * height > maxPixels
            ) {
              throw new Error(`${side.label} dimensions exceed the exact comparison budget`);
            }
            if (width !== side.geometry.width || height !== side.geometry.height) {
              throw new Error(`${side.label} decoded dimensions differ from its container`);
            }
            if (
              !Number.isSafeInteger(duration) ||
              duration <= 0 ||
              side.endUs + duration > maxDurationUs
            ) {
              throw new Error(`${side.label} duration exceeds the exact comparison budget`);
            }
            side.decodedPixels += width * height;
            if (side.decodedPixels > maxDecodedPixels) {
              throw new Error(`${side.label} decoded work exceeds the exact comparison budget`);
            }
            if (!side.canvas) {
              side.canvas = new OffscreenCanvas(width, height);
              side.context = side.canvas.getContext('2d', {
                willReadFrequently: true,
                colorSpace: 'srgb',
              });
              if (!side.context) throw new Error('Unable to read composited animation pixels');
            } else if (width !== side.canvas.width || height !== side.canvas.height) {
              throw new Error(`${side.label} frame dimensions changed`);
            }
            side.context.clearRect(0, 0, width, height);
            side.context.drawImage(image, 0, 0);
            side.pixels = side.context.getImageData(0, 0, width, height).data;
            for (let offset = 3; offset < side.pixels.length; offset += 4) {
              if (side.pixels[offset] !== 255) {
                throw new Error(`${side.label} contains non-opaque composited pixels`);
              }
            }
            side.endUs += duration;
            return true;
          } finally {
            image.close();
          }
        };

        const comparePixels = () => {
          if (
            left.canvas.width !== right.canvas.width ||
            left.canvas.height !== right.canvas.height
          ) {
            throw new Error('Animated output dimensions differ');
          }
          for (let offset = 0; offset < left.pixels.length; offset++) {
            if (left.pixels[offset] !== right.pixels[offset]) {
              throw new Error(`Animated output pixels differ at RGBA byte ${offset}`);
            }
          }
        };

        await readNext(left);
        await readNext(right);
        let boundaryUs = 0;
        let comparedIntervals = 0;
        while (true) {
          comparePixels();
          const nextBoundaryUs = Math.min(left.endUs, right.endUs);
          if (nextBoundaryUs <= boundaryUs)
            throw new Error('Invalid animation presentation boundary');
          boundaryUs = nextBoundaryUs;
          comparedIntervals++;
          const advanceLeft = left.endUs === boundaryUs;
          const advanceRight = right.endUs === boundaryUs;
          const hasLeft = !advanceLeft || (await readNext(left));
          const hasRight = !advanceRight || (await readNext(right));
          if (!hasLeft || !hasRight) {
            if (hasLeft !== hasRight || left.endUs !== right.endUs) {
              throw new Error('Animated output presentation duration differs');
            }
            break;
          }
        }

        // The loop edge is a presentation boundary too. Re-decode the first
        // composited frame instead of keeping another full-frame pixel buffer.
        left.nextIndex = 0;
        right.nextIndex = 0;
        left.endUs = 0;
        right.endUs = 0;
        await readNext(left);
        await readNext(right);
        comparePixels();

        return {
          width: left.canvas.width,
          height: left.canvas.height,
          durationUs: boundaryUs,
          repetitionCount: left.track.repetitionCount,
          referenceFrameCount: left.track.frameCount,
          candidateFrameCount: right.track.frameCount,
          comparedIntervals,
          loopTransitionChecked: true,
        };
      } finally {
        for (const decoder of decoders) decoder.close();
      }
    },
    {
      reference: [...referenceBytes],
      candidate: [...candidateBytes],
      referenceMimeType: referenceFormat === 'gif' ? 'image/gif' : 'image/webp',
      candidateMimeType: candidateFormat === 'gif' ? 'image/gif' : 'image/webp',
      referenceGeometry,
      candidateGeometry,
    }
  );
}
