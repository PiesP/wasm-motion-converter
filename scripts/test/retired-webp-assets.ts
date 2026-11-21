/** Exact executable retirement controls from the verified 7d9e0f1b Pages inventory. */
export const LEGACY_WEBP_DEPLOYMENT = {
  sourceSha: '7d9e0f1bc6cfcf01a04052674f1b500c8a4b9cd3',
  treeSha: '0018da499f5e6217d19b13c834c0dbb54c3a49c8',
  manifestSha256: '30ba5d41eb2c580eec20a814ae694594365a24d14c6cd1eeac24e3f498d31fa9',
  headersSha256: 'f4d69cddce26bc5484031502995f040374f5b5625d44d9a438a1e1a22be5cb8f',
  inventoryCount: 29,
  // SHA-256 of the ordered served inventory projected onto path, size and SHA-256.
  inventorySha256: '51f5765182587b40b92513af7d605fdb8fe54ffaf03e3e12526533ab9d2d8cc5',
  files: [
    {
      path: 'assets/wasm-webp.Wg4Zhl1L.js',
      size: 51996,
      sha256: '591bd59ee5da2104693bf7e5bec2b8c1dc85527d3ca21d7b05231c2b1c25499b',
    },
    {
      path: 'assets/webp-wasm-BqUWQtOZ.js',
      size: 52286,
      sha256: '15cd582651f78831babe9b54012388f22614c48b39c899fa2772e62b037dae47',
    },
    {
      path: 'assets/webp-wasm-DhoM6Y9t.wasm',
      size: 482273,
      sha256: '4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22',
    },
  ],
} as const;

// This generated module imports the old WebP loader. The three warmed codec
// files above also serve as positive controls for the predecessor's route.
export const RETIRED_WEBP_SHIM = {
  path: 'assets/__vite-browser-external-Cz17a1zo.js',
  size: 112,
  sha256: '41bec85a9923dc9b6d96dde6cbdb5897cc9130d649f3310d6b92fa5dd8f30280',
} as const;

export const RETIRED_WEBP_EXECUTABLES = [...LEGACY_WEBP_DEPLOYMENT.files, RETIRED_WEBP_SHIM];

export const RETIRED_REQUEST_MODES = ['ordinary', 'revalidated'] as const;

const LEGACY_WEBP_EXECUTABLE = /(?:^|\/)(?:webp-wasm|wasm-webp)(?:[.-][\w-]+)*\.(?:wasm|[cm]?js)$/i;

export function isRetiredWebpExecutable(path: string, sha256?: string): boolean {
  return (
    LEGACY_WEBP_EXECUTABLE.test(path) ||
    path === RETIRED_WEBP_SHIM.path ||
    path === `/${RETIRED_WEBP_SHIM.path}` ||
    (sha256 !== undefined && RETIRED_WEBP_EXECUTABLES.some((file) => file.sha256 === sha256))
  );
}

export const OWNED_VP8_ASSET = /^assets\/owned-vp8[-.][\w-]{8}\.wasm$/;
export const LEGACY_WEBP_WASM_ASSET = /^assets\/(?:webp-wasm|wasm-webp)[-.][\w-]{8}\.wasm$/;
const OTHER_OWNED_WASM = /^assets\/(?:owned-demux|gif-scalar-quantizer)[-.][\w-]{8}\.wasm$/;

export function isUnexpectedWasm(path: string) {
  return path.endsWith('.wasm') && !OWNED_VP8_ASSET.test(path) && !OTHER_OWNED_WASM.test(path);
}

export function isExecutableMediaType(value: string) {
  return /(?:javascript|ecmascript|wasm|octet-stream)/i.test(value);
}
