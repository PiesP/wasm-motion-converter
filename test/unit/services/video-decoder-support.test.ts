// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkVideoDecoderSupport } from '@services/video-decoder-support';

const config: VideoDecoderConfig = {
  codec: 'hev1.1.6.L123.90',
  codedWidth: 1920,
  codedHeight: 1080,
};

describe('checkVideoDecoderSupport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([true, false])('returns an explicit browser support result (%s)', async (supported) => {
    const isConfigSupported = vi.fn().mockResolvedValue({ config, supported });
    vi.stubGlobal('VideoDecoder', { isConfigSupported });

    await expect(checkVideoDecoderSupport(config)).resolves.toBe(supported);
    expect(isConfigSupported).toHaveBeenCalledWith(config);
  });

  it('returns unknown when VideoDecoder is unavailable', async () => {
    vi.stubGlobal('VideoDecoder', undefined);

    await expect(checkVideoDecoderSupport(config)).resolves.toBeNull();
  });

  it('returns unknown when the browser support probe rejects', async () => {
    vi.stubGlobal('VideoDecoder', {
      isConfigSupported: vi.fn().mockRejectedValue(new Error('probe failed')),
    });

    await expect(checkVideoDecoderSupport(config)).resolves.toBeNull();
  });
});
