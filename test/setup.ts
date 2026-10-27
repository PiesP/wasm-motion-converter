// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP
//
// Global test setup for wasm-motion-converter
// - Logger mock (silences logs during tests)
// - Controlled CDN dependency boundaries

import { vi } from 'vite-plus/test';

// ── Logger Mock ───────────────────────────────────────────────

vi.mock('@utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Virtual CDN Module Mock ───────────────────────────────────

vi.mock('virtual:cdn-deps', () => ({
  esmShModuleUrl: 'https://esm.sh/mock-module',
}));

// Mock cdn-config to keep virtual CDN resolution out of unit tests.
vi.mock('@utils/cdn-config', () => ({
  getRuntimeDepVersion: () => '0.12.10',
  getCDNProviders: () => [],
  esmShModuleUrl: 'https://esm.sh/mock',
}));

// ── Lifecycle Hooks ───────────────────────────────────────────

beforeEach(() => {
  if (typeof document !== 'undefined') {
    document.body.innerHTML = '';
  }
});
