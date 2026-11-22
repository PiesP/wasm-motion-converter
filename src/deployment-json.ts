// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export async function readDeploymentJson(
  response: Response,
  expectedUrl: string,
  maxBytes: number
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing deployment metadata body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (
      response.status !== 200 ||
      response.redirected ||
      response.url !== expectedUrl ||
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/json'
    )
      throw new Error('Unusable deployment metadata response');

    const contentLength = response.headers.get('content-length');
    if (
      contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)
    )
      throw new Error('Invalid deployment metadata length');
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Deployment metadata is too large');
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
