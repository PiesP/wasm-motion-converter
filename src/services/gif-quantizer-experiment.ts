// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// Adapted from gifenc 1.0.3 src/pnnquant2.js (MIT), by Mark Tyler,
// Dmitry Groshev, and Miller Cy Chan. See public/LICENSES.md for notices.

/**
 * Exact rgb565 PNN quantizer experiment. The histogram, heap and bin objects
 * belong to one conversion and are reset for each frame. Keep the upstream
 * arithmetic and traversal order: palette ties affect applyPalette output.
 */
interface Bin {
  rc: number;
  gc: number;
  bc: number;
  cnt: number;
  nn: number;
  fw: number;
  bk: number;
  tm: number;
  mtm: number;
  err: number;
}

const BIN_COUNT = 65_536;
const DELETED = BIN_COUNT - 1;

function makeBin(): Bin {
  return { rc: 0, gc: 0, bc: 0, cnt: 0, nn: 0, fw: 0, bk: 0, tm: 0, mtm: 0, err: 0 };
}

function resetBin(bin: Bin): void {
  bin.rc = 0;
  bin.gc = 0;
  bin.bc = 0;
  bin.cnt = 0;
  bin.nn = 0;
  bin.fw = 0;
  bin.bk = 0;
  bin.tm = 0;
  bin.mtm = 0;
  bin.err = 0;
}

function sqr(value: number): number {
  return value * value;
}

function findNearest(bins: Bin[], idx: number): void {
  let nn = 0;
  let err = 1e100;
  const first = bins[idx]!;
  const n1 = first.cnt;
  const wr = first.rc;
  const wg = first.gc;
  const wb = first.bc;
  for (let i = first.fw; i !== 0; i = bins[i]!.fw) {
    const bin = bins[i]!;
    const n2 = bin.cnt;
    const nerr2 = (n1 * n2) / (n1 + n2);
    if (nerr2 >= err) continue;
    let nerr = 0;
    nerr += nerr2 * sqr(bin.rc - wr);
    if (nerr >= err) continue;
    nerr += nerr2 * sqr(bin.gc - wg);
    if (nerr >= err) continue;
    nerr += nerr2 * sqr(bin.bc - wb);
    if (nerr >= err) continue;
    err = nerr;
    nn = i;
  }
  first.err = err;
  first.nn = nn;
}

export function createExactRgb565Quantizer(): (rgba: Uint8Array, maxColors: number) => number[][] {
  const histogram: Array<Bin | undefined> = Array.from({ length: BIN_COUNT });
  const ordered: Bin[] = [];
  const pool: Bin[] = [];
  const heap = new Uint32Array(BIN_COUNT + 1);

  return (rgba, maxColors) => {
    if (
      !(rgba instanceof Uint8Array) ||
      rgba.byteOffset !== 0 ||
      rgba.byteLength !== rgba.buffer.byteLength ||
      (rgba.byteLength & 3) !== 0 ||
      rgba.byteLength === 0 ||
      !Number.isInteger(maxColors) ||
      maxColors < 1 ||
      maxColors > 256
    ) {
      throw new RangeError('Exact rgb565 quantizer requires whole nonempty RGBA and 1–256 colors');
    }

    const data = new Uint32Array(rgba.buffer);
    let used = 0;
    for (let i = 0; i < data.length; i++) {
      const color = data[i]!;
      const b = (color >> 16) & 0xff;
      const g = (color >> 8) & 0xff;
      const r = color & 0xff;
      const index = ((r << 8) & 0xf800) | ((g << 2) & 0x03e0) | (b >> 3);
      let bin = histogram[index];
      if (!bin) {
        bin = pool[used] ?? makeBin();
        if (used === pool.length) pool.push(bin);
        resetBin(bin);
        histogram[index] = bin;
        used++;
      }
      bin.rc += r;
      bin.gc += g;
      bin.bc += b;
      bin.cnt++;
    }

    ordered.length = used;
    let maxbins = 0;
    for (let i = 0; i < BIN_COUNT; i++) {
      const bin = histogram[i];
      if (bin) {
        const d = 1.0 / bin.cnt;
        bin.rc *= d;
        bin.gc *= d;
        bin.bc *= d;
        ordered[maxbins++] = bin;
        histogram[i] = undefined;
      }
    }

    let useSqrt = true;
    if (sqr(maxColors) / maxbins < 0.022) useSqrt = false;
    for (let i = 0; i < maxbins - 1; i++) {
      ordered[i]!.fw = i + 1;
      ordered[i + 1]!.bk = i;
      if (useSqrt) ordered[i]!.cnt = Math.sqrt(ordered[i]!.cnt);
    }
    if (useSqrt) ordered[maxbins - 1]!.cnt = Math.sqrt(ordered[maxbins - 1]!.cnt);

    heap[0] = 0;
    for (let i = 0; i < maxbins; i++) {
      findNearest(ordered, i);
      const err = ordered[i]!.err;
      let l = ++heap[0]!;
      while (l > 1) {
        const parent = l >> 1;
        const h = heap[parent]!;
        if (ordered[h]!.err <= err) break;
        heap[l] = h;
        l = parent;
      }
      heap[l] = i;
    }

    const extbins = maxbins - maxColors;
    for (let i = 0; i < extbins;) {
      let tb: Bin;
      for (;;) {
        let b1 = heap[1]!;
        tb = ordered[b1]!;
        if (tb.tm >= tb.mtm && ordered[tb.nn]!.mtm <= tb.tm) break;
        if (tb.mtm === DELETED) {
          b1 = heap[1] = heap[heap[0]!--]!;
        } else {
          findNearest(ordered, b1);
          tb.tm = i;
        }
        const err = ordered[b1]!.err;
        let l = 1;
        while (true) {
          let child = l + l;
          if (child > heap[0]!) break;
          if (child < heap[0]! && ordered[heap[child]!]!.err > ordered[heap[child + 1]!]!.err) {
            child++;
          }
          const h = heap[child]!;
          if (err <= ordered[h]!.err) break;
          heap[l] = h;
          l = child;
        }
        heap[l] = b1;
      }

      const nb = ordered[tb.nn]!;
      const n1 = tb.cnt;
      const n2 = nb.cnt;
      const d = 1.0 / (n1 + n2);
      tb.rc = d * (n1 * tb.rc + n2 * nb.rc);
      tb.gc = d * (n1 * tb.gc + n2 * nb.gc);
      tb.bc = d * (n1 * tb.bc + n2 * nb.bc);
      tb.cnt += nb.cnt;
      tb.mtm = ++i;
      ordered[nb.bk]!.fw = nb.fw;
      ordered[nb.fw]!.bk = nb.bk;
      nb.mtm = DELETED;
    }

    const palette: number[][] = [];
    for (let i = 0; ;) {
      const bin = ordered[i]!;
      const color = [
        Math.min(255, Math.max(0, Math.round(bin.rc))),
        Math.min(255, Math.max(0, Math.round(bin.gc))),
        Math.min(255, Math.max(0, Math.round(bin.bc))),
      ];
      if (
        !palette.some(
          (item) => item[0] === color[0] && item[1] === color[1] && item[2] === color[2]
        )
      ) {
        palette.push(color);
      }
      i = bin.fw;
      if (i === 0) break;
    }
    return palette;
  };
}
