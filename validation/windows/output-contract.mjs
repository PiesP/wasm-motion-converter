// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

/** Decode every animation frame in the target browser and validate the shared contract. */
export async function verifyAnimatedOutput(page, bytes, contract, markers) {
  const observation = await page.evaluate(
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
                distance: Math.hypot(
                  rgb[0] - color[0],
                  rgb[1] - color[1],
                  rgb[2] - color[2]
                ),
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
      mimeType: contract.format === 'gif' ? 'image/gif' : 'image/webp',
      markerColors: markers,
    }
  );

  assert.equal(observation.frameCount, contract.expected.markers.length, `${contract.id}: frame count`);
  assert.deepEqual(
    observation.frames.map((frame) => frame.marker),
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
    assert(
      Math.abs(frame.durationMs - contract.expected.durationsMs[index]) <=
        contract.expected.durationToleranceMs,
      `${contract.id}: frame ${index} duration ${frame.durationMs}ms`
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
  assert(
    Math.abs(
      observation.frames.reduce((sum, frame) => sum + frame.durationMs, 0) -
        contract.expected.durationsMs.reduce((sum, duration) => sum + duration, 0)
    ) <= contract.expected.durationToleranceMs,
    `${contract.id}: total playback duration`
  );
  return observation;
}
