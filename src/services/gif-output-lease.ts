// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export function acquireGifOutputLease(name: string): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    let release!: () => void;
    const hold = new Promise<void>((done) => {
      release = done;
    });
    const task = navigator.locks.request(name, async () => {
      resolve(async () => {
        release();
        await task;
      });
      await hold;
    });
    void task.catch(reject);
  });
}
