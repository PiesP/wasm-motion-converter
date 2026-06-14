// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

// Mock cdn-config BEFORE any other imports (vi.mock is hoisted)
vi.mock('@utils/cdn-config', () => ({
  getRuntimeDepVersion: () => '0.12.10',
  getCDNProviders: () => [],
  esmShModuleUrl: 'https://esm.sh/mock',
}));

import { describe, it, expect, vi } from 'vitest';
import { validateVideoFile } from '@utils/file-validation';

describe('validateVideoFile', () => {
  it('accepts valid MP4 file with correct MIME', () => {
    const file = new File(['dummy'], 'video.mp4', { type: 'video/mp4' });
    const result = validateVideoFile(file);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts valid WebM file', () => {
    const file = new File(['dummy'], 'video.webm', { type: 'video/webm' });
    const result = validateVideoFile(file);
    expect(result.valid).toBe(true);
  });

  it('accepts valid MOV file', () => {
    const file = new File(['dummy'], 'video.mov', { type: 'video/quicktime' });
    const result = validateVideoFile(file);
    expect(result.valid).toBe(true);
  });

  it('accepts file with unsupported MIME but valid extension', () => {
    const file = new File(['dummy'], 'video.mp4', { type: '' });
    const result = validateVideoFile(file);
    expect(result.valid).toBe(true);
  });

  it('accepts file with valid extension in uppercase', () => {
    const file = new File(['dummy'], 'video.MP4', { type: '' });
    const result = validateVideoFile(file);
    expect(result.valid).toBe(true);
  });

  it('rejects file exceeding size limit', () => {
    const oversized = new File([new ArrayBuffer(500 * 1024 * 1024 + 1)], 'video.mp4', {
      type: 'video/mp4',
    });
    const result = validateVideoFile(oversized);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too large');
  });

  it('rejects file with unsupported MIME and no valid extension', () => {
    const file = new File(['dummy'], 'video.xyz', { type: 'application/octet-stream' });
    const result = validateVideoFile(file);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unsupported');
  });

  it('rejects file with video/* MIME but unsupported extension (not in supported list)', () => {
    // video/x-flv is actually in SUPPORTED_VIDEO_MIMES, so use a truly unsupported one
    const file = new File(['dummy'], 'video.xyz', { type: 'video/x-unsupported' });
    const result = validateVideoFile(file);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unsupported video format');
  });

  it('rejects file with no MIME and no valid extension', () => {
    const file = new File(['dummy'], 'video.xyz', { type: '' });
    const result = validateVideoFile(file);
    expect(result.valid).toBe(false);
  });

  it('handles case-insensitive MIME matching', () => {
    const file = new File(['dummy'], 'video.mp4', { type: 'VIDEO/MP4' });
    const result = validateVideoFile(file);
    expect(result.valid).toBe(true);
  });

  it('accepts all supported MIME types', () => {
    const mimes = [
      'video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo',
      'video/x-matroska', 'video/x-m4v', 'video/ogg', 'video/mpeg',
      'video/mp2t', 'video/x-ms-wmv', 'video/x-flv',
    ];
    for (const mime of mimes) {
      const file = new File(['dummy'], 'video.mp4', { type: mime });
      const result = validateVideoFile(file);
      expect(result.valid).toBe(true);
    }
  });

  it('accepts all supported extensions', () => {
    const exts = ['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v', 'ogv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'wmv', 'flv'];
    for (const ext of exts) {
      const file = new File(['dummy'], `video.${ext}`, { type: '' });
      const result = validateVideoFile(file);
      expect(result.valid).toBe(true);
    }
  });
});
