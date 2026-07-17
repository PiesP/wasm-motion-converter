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

// Mock translation function that returns the key with optional params
const mockT = vi.fn((key: string, params?: Record<string, string | number>) => {
  const messages: Record<string, string> = {
    'validation.fileTooLarge': 'File too large (max 500MB). Please trim or compress your video.',
    'validation.unsupportedFormat': 'Unsupported format. Please choose a common video format.',
    'validation.unsupportedMimeType': `Unsupported video format (${params?.mimeType ?? 'unknown'}). Please convert your file first.`,
  };
  return messages[key] ?? key;
});

describe('validateVideoFile', () => {
  it('accepts valid MP4 file with correct MIME', async () => {
    const file = new File(['dummy'], 'video.mp4', { type: 'video/mp4' });
    const result = await validateVideoFile(file, mockT);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts valid WebM file', async () => {
    const file = new File(['dummy'], 'video.webm', { type: 'video/webm' });
    const result = await validateVideoFile(file, mockT);
    expect(result.valid).toBe(true);
  });

  it('accepts valid MOV file', async () => {
    const file = new File(['dummy'], 'video.mov', { type: 'video/quicktime' });
    const result = await validateVideoFile(file, mockT);
    expect(result.valid).toBe(true);
  });

  it('accepts file with unsupported MIME but valid extension', async () => {
    const file = new File(['dummy'], 'video.mp4', { type: '' });
    const result = await validateVideoFile(file, mockT);
    expect(result.valid).toBe(true);
  });

  it('accepts file with valid extension in uppercase', async () => {
    const file = new File(['dummy'], 'video.MP4', { type: '' });
    const result = await validateVideoFile(file, mockT);
    expect(result.valid).toBe(true);
  });

  it('rejects file exceeding size limit', async () => {
    const oversized = new File([new ArrayBuffer(500 * 1024 * 1024 + 1)], 'video.mp4', {
      type: 'video/mp4',
    });
    const result = await validateVideoFile(oversized, mockT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too large');
  });

  it('rejects file with unsupported MIME and no valid extension', async () => {
    const file = new File(['dummy'], 'video.xyz', { type: 'application/octet-stream' });
    const result = await validateVideoFile(file, mockT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unsupported');
  });

  it('rejects file with video/* MIME but unsupported extension (not in supported list)', async () => {
    const file = new File(['dummy'], 'video.xyz', { type: 'video/x-unsupported' });
    const result = await validateVideoFile(file, mockT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unsupported video format');
  });

  it('rejects file with no MIME and no valid extension', async () => {
    const file = new File(['dummy'], 'video.xyz', { type: '' });
    const result = await validateVideoFile(file, mockT);
    expect(result.valid).toBe(false);
  });

  it('handles case-insensitive MIME matching', async () => {
    const file = new File(['dummy'], 'video.mp4', { type: 'VIDEO/MP4' });
    const result = await validateVideoFile(file, mockT);
    expect(result.valid).toBe(true);
  });

  it('accepts all supported MIME types', async () => {
    const mimes = [
      'video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo',
      'video/x-matroska', 'video/x-m4v', 'video/ogg', 'video/mpeg',
      'video/mp2t', 'video/x-ms-wmv', 'video/x-flv',
    ];
    for (const mime of mimes) {
      const file = new File(['dummy'], 'video.mp4', { type: mime });
      const result = await validateVideoFile(file, mockT);
      expect(result.valid).toBe(true);
    }
  });

  it('accepts all supported extensions', async () => {
    const exts = ['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v', 'ogv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'wmv', 'flv'];
    for (const ext of exts) {
      const file = new File(['dummy'], `video.${ext}`, { type: '' });
      const result = await validateVideoFile(file, mockT);
      expect(result.valid).toBe(true);
    }
  });
});
