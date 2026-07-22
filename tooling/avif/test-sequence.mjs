import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(resolve('public/wasm/avif-encoder.js')).href;
const createModule = (await import(moduleUrl)).default;
const wasmBinary = await readFile(resolve('public/wasm/avif-encoder.wasm'));
const module = await createModule({
  instantiateWasm(imports, receiveInstance) {
    void WebAssembly.instantiate(wasmBinary, imports).then(({ instance }) => receiveInstance(instance));
    return {};
  },
});

const width = 4;
const height = 4;
const makeFrame = (red, green, blue) => {
  const frame = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < frame.length; offset += 4) {
    frame[offset] = red;
    frame[offset + 1] = green;
    frame[offset + 2] = blue;
    frame[offset + 3] = 255;
  }
  return frame;
};

const encoder = new module.AvifAnimationEncoder(width, height, 4, 50, 8, -1);
let output;
try {
  for (const [frame, duration] of [
    [makeFrame(255, 0, 0), 50],
    [makeFrame(0, 255, 0), 100],
    [makeFrame(0, 0, 255), 200],
  ]) {
    encoder.addFrame(frame, duration);
  }
  output = encoder.finish();
} finally {
  encoder.delete();
}

assert.ok(output instanceof Uint8Array, 'encoder must return Uint8Array');
assert.ok(output.byteLength > 32, 'encoded AVIF sequence must not be empty');
assert.equal(new TextDecoder().decode(output.slice(4, 8)), 'ftyp');
assert.equal(new TextDecoder().decode(output.slice(8, 12)), 'avis');

const readUint32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
const readBoxType = (bytes, offset) => new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));

const parseBoxes = (bytes, start = 0, end = bytes.byteLength) => {
  const boxes = [];
  for (let offset = start; offset + 8 <= end; ) {
    const size = readUint32(bytes, offset);
    const boxEnd = size === 0 ? end : offset + size;
    if (boxEnd <= offset || boxEnd > end) break;
    boxes.push({ end: boxEnd, start: offset, type: readBoxType(bytes, offset) });
    offset = boxEnd;
  }
  return boxes;
};

const childrenOf = (box) => parseBoxes(output, box.type === 'meta' ? box.start + 12 : box.start + 8, box.end);
const findChild = (box, type) => childrenOf(box).find((child) => child.type === type);
const moov = parseBoxes(output).find((box) => box.type === 'moov');
const movieHeader = moov && findChild(moov, 'mvhd');
const track = moov && findChild(moov, 'trak');
const media = track && findChild(track, 'mdia');
const mediaInformation = media && findChild(media, 'minf');
const sampleTable = mediaInformation && findChild(mediaInformation, 'stbl');
const timeToSample = sampleTable && findChild(sampleTable, 'stts');

assert.ok(timeToSample, 'animated AVIF must contain a time-to-sample box');
const movieHeaderVersion = output[movieHeader.start + 8];
const movieHeaderTimescaleOffset = movieHeaderVersion === 1 ? movieHeader.start + 28 : movieHeader.start + 20;
assert.equal(readUint32(output, movieHeaderTimescaleOffset), 1000);
assert.equal(readUint32(output, timeToSample.start + 12), 3);
assert.deepEqual(
  [0, 1, 2].map((index) => readUint32(output, timeToSample.start + 20 + index * 8)),
  [50, 100, 200],
);

console.log(JSON.stringify({ bytes: output.byteLength, brand: 'avis', frameDurations: [50, 100, 200] }));
