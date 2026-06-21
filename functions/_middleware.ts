// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Cloudflare Pages Functions Middleware
 *
 * Injects COOP/COEP headers on every response to enable SharedArrayBuffer.
 * The _headers file approach is unreliable for these specific headers on
 * *.pages.dev subdomains, so we enforce them at the Functions level.
 */

export const onRequest = async ({ next }: { next: () => Promise<Response> }): Promise<Response> => {
  const response = await next();
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, headers });
};
