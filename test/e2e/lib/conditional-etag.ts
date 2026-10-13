/** Diagnose the maintained Pages/Wrangler integration's 304 compatibility exception. */
export function conditionalEtagObservation(
  url: string,
  etag: string,
  conditionalEtag: string | undefined,
  wranglerProfile: boolean
): { conditionalEtag: string | null; rfc9110Etag: boolean; compatibilityException: string | null } {
  if (!/^(?:W\/)?"[^\"]+"$/.test(etag)) throw new Error('200 response has no usable ETag');
  if (conditionalEtag !== undefined) {
    if (conditionalEtag !== etag) throw new Error('304 ETag differs from its 200 validator');
    return { conditionalEtag, rfc9110Etag: true, compatibilityException: null };
  }
  const target = new URL(url);
  const pages =
    target.protocol === 'https:' &&
    /^(?:[a-f0-9]{8}\.)?wasm-motion-converter\.pages\.dev$/.test(target.hostname);
  const wrangler =
    wranglerProfile &&
    target.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
  // RFC 9110 15.4.5 requires this ETag because the corresponding 200 has one.
  // Missing 304 validators were observed in Pages/Wrangler in #289/#292;
  // tolerate that platform deviation only on these maintained integration targets.
  if (!pages && !wrangler) throw new Error('304 omitted the ETag required by RFC 9110');
  return {
    conditionalEtag: null,
    rfc9110Etag: false,
    compatibilityException: pages ? 'pages-304-etag-omission' : 'wrangler-304-etag-omission',
  };
}
