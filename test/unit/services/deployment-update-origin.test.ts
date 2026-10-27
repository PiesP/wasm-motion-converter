// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { observeDeploymentUpdates } from '../../../src/deployment-update';

const localSha = 'a'.repeat(40);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deployment update origin policy', () => {
  it.each(['file:///tmp/app.html', 'data:text/html,app', 'http://example.test/app'])(
    'rejects unsafe origin %s',
    (href) => {
      vi.stubGlobal('location', { href });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      observeDeploymentUpdates({ sourceSha: localSha, onUpdate: vi.fn() })();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('requests metadata at the HTTPS application origin', () => {
    vi.stubGlobal('location', { href: 'https://drop.test/?entry=one' });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('navigator', { onLine: true });
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const cleanup = observeDeploymentUpdates({ sourceSha: localSha, onUpdate: vi.fn() });
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      new URL('https://drop.test/deployment-state.json')
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ mode: 'same-origin', redirect: 'error' })
    );
    cleanup();
  });
});
