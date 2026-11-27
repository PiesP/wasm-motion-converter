// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createGifPartIndexedDbSink } from '@services/gif-part-indexed-db-sink';
import { expect, it, vi } from 'vite-plus/test';

function complete<Value>(request: IDBRequest<Value>): Promise<Value> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

it('reclaims abandoned staged data after a worker exits and preserves active and legacy stores', async () => {
  const names = async () => (await indexedDB.databases()).map(({ name }) => name);
  const uuid = crypto.randomUUID();
  const abandoned = `dropconvert-gif-v2-${uuid}`;
  const legacy = `dropconvert-gif-${uuid}`;
  const legacyConnection = await complete(indexedDB.open(legacy));
  legacyConnection.close();
  const before = await names();
  const active = await createGifPartIndexedDbSink();
  const signal = new AbortController().signal;
  const bytes = new TextEncoder().encode('GIF89a;').buffer;
  await active.save({ index: 1, startCs: 0, endCs: 5, frameCount: 1, bytes }, signal);
  const activeName = (await names()).find((name) => !before.includes(name));
  expect(activeName).toBeDefined();
  const source = `
    onmessage = ({data:name}) => navigator.locks.request(name, async () => {
      const request = indexedDB.open(name,1);
      request.onupgradeneeded = () => request.result.createObjectStore('chunks');
      const database = await new Promise((resolve,reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction=database.transaction('chunks','readwrite');
      transaction.objectStore('chunks').add(new ArrayBuffer(4), ['part.gif',0]);
      await new Promise((resolve,reject)=>{
        transaction.oncomplete=resolve;
        transaction.onabort=()=>reject(transaction.error);
      });
      postMessage('committed');
      await new Promise(() => {});
    }).catch(error => postMessage(String(error)));
  `;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url);
  try {
    const committed = new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = reject;
    });
    worker.postMessage(abandoned);
    expect(await committed).toBe('committed');
    const whileActive = await createGifPartIndexedDbSink();
    expect(await names()).toEqual(expect.arrayContaining([activeName, abandoned, legacy]));
    await whileActive.dispose();
    worker.terminate();
    await vi.waitFor(async () => {
      const state = await navigator.locks.query();
      expect(state.held?.some(({ name }) => name === abandoned)).toBe(false);
    });
    expect(await names()).toContain(abandoned);

    const afterExit = await createGifPartIndexedDbSink();
    try {
      expect(await names()).not.toContain(abandoned);
      expect(await names()).toEqual(expect.arrayContaining([activeName, legacy]));
      expect(await (await active.read(active.files()[0]!.filename, signal)).arrayBuffer()).toEqual(
        bytes
      );
    } finally {
      await afterExit.dispose();
    }
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
    await active.dispose();
    await complete(indexedDB.deleteDatabase(legacy));
    await complete(indexedDB.deleteDatabase(abandoned));
  }
});
