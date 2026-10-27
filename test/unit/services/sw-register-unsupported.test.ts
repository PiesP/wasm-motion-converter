// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { registerServiceWorker } from '../../../src/sw-register';

afterEach(() => vi.unstubAllGlobals());

describe('service worker feature detection', () => {
  it('reports unsupported when the navigator has no serviceWorker property', async () => {
    vi.stubGlobal('navigator', {});
    expect(await registerServiceWorker()).toEqual({ supported: false, registered: false });
  });
});
