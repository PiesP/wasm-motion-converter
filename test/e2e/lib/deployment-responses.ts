import { expect, type Response } from '@playwright/test';

type ExecutableKind = 'js' | 'css' | 'wasm';

const MIME: Record<ExecutableKind, RegExp> = {
  js: /^(?:text|application)\/(?:javascript|ecmascript)(?:\s*;|$)/i,
  css: /^text\/css(?:\s*;|$)/i,
  wasm: /^application\/wasm(?:\s*;|$)/i,
};

export function assertExecutableBody(kind: ExecutableKind, status: number, contentType: string | null, bytes: Uint8Array): void {
  expect(status, `${kind} response status`).toBe(200);
  expect(contentType, `${kind} response MIME`).toMatch(MIME[kind]);
  expect(bytes.byteLength, `${kind} response body`).toBeGreaterThan(0);
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 256))).trimStart();
  expect(prefix.toLowerCase(), `${kind} HTML fallback`).not.toMatch(/^<!doctype html\b|^<html\b/);
  if (kind === 'wasm') {
    expect(Array.from(bytes.subarray(0, 4)), 'WASM magic').toEqual([0, 97, 115, 109]);
  }
}

export async function assertExecutableResponse(response: Response, kind: ExecutableKind, origin: string): Promise<void> {
  expect(new URL(response.url()).origin, `${kind} response origin`).toBe(origin);
  expect(response.request().redirectedFrom(), `${kind} unexpected redirect`).toBeNull();
  assertExecutableBody(kind, response.status(), response.headers()['content-type'] ?? null, await response.body());
}
