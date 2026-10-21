import { createHash } from 'node:crypto';
/** Opt-in Pages evidence: imported before Corepack/pnpm executes its entrypoint. */
import { readFileSync, realpathSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';

type Observation = {
  url: string;
  transport: 'https' | 'fetch';
  tls: 'accepted' | 'error';
  status?: number;
  code?: string;
};

const urls = [
  'https://nodejs.org/',
  'https://dv-g3b-emudhra.we-have-a-problem.com/',
  'https://dv-g3b-aaa-emudhra.we-have-a-problem.com/',
];
const certificateErrors = new Set([
  'CERT_REVOKED',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function errorCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : null;
  }
  return 'UNATTRIBUTED_ERROR';
}

function probeHttps(url: string): Promise<Observation> {
  return new Promise((resolve) => {
    const agent = new https.Agent({ rejectUnauthorized: true, maxCachedSessions: 0 });
    const request = https.get(url, { agent }, (response) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      agent.destroy();
      resolve({ url, transport: 'https', tls: 'accepted', status });
    });
    const deadline = setTimeout(() => request.destroy(new Error('TLS deadline exceeded')), 15_000);
    request.on('error', (error) => {
      agent.destroy();
      resolve({ url, transport: 'https', tls: 'error', code: errorCode(error) });
    });
    request.on('close', () => clearTimeout(deadline));
  });
}

async function probeFetch(url: string): Promise<Observation> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
    return { url, transport: 'fetch', tls: 'accepted', status: response.status };
  } catch (error) {
    return { url, transport: 'fetch', tls: 'error', code: errorCode(error) };
  }
}

if (process.env.CF_PAGES !== '1' || process.env.PAGES_NODE_QUALIFICATION !== '1') {
  throw new Error('Pages runtime qualification requires an explicit provider opt-in');
}
const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
) as {
  packageManager: string;
  volta: { node: string };
};
if (process.versions.node !== manifest.volta.node)
  throw new Error('Unqualified package-manager Node');
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined) {
  throw new Error('TLS verification overrides are unsupported');
}
const entry = process.argv[1];
if (!entry || !/\.[cm]?js$/u.test(realpathSync(entry))) {
  throw new Error('Pages package manager must use a JavaScript entrypoint');
}
const results = (
  await Promise.all(urls.map(async (url) => [await probeHttps(url), await probeFetch(url)]))
).flat();
const passed = results.every((result) =>
  result.url === urls[0] ? result.tls === 'accepted' : certificateErrors.has(result.code ?? '')
);
console.error(
  `[pages-runtime] ${JSON.stringify({
    observed_at: new Date().toISOString(),
    version: process.version,
    executable: process.execPath,
    entry: realpathSync(entry),
    ca_settings: Object.fromEntries(
      [
        'NODE_OPTIONS',
        'NODE_EXTRA_CA_CERTS',
        'NODE_TLS_REJECT_UNAUTHORIZED',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
      ].map((key) => [key, process.env[key] ?? null])
    ),
    sample_coverage: 'one direct and one cross-signed chain',
    results,
    passed,
  })}`
);
if (!passed) throw new Error('Pages package-manager TLS qualification failed');

// Corepack replaces argv before loading pnpm in this same Node process. Bind the
// receipt to the final package entry, rather than only its initial launcher.
process.on('exit', () => {
  try {
    const finalEntry = realpathSync(process.argv[1] ?? '');
    const packageRoot = dirname(dirname(finalEntry));
    const manager = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    const managerPassed =
      /\/bin\/pnpm\.[cm]js$/u.test(finalEntry) &&
      manager.name === 'pnpm' &&
      `pnpm@${manager.version}` === manifest.packageManager;
    console.error(
      `[pages-package-manager] ${JSON.stringify({
        version: manager.version,
        node: process.version,
        executable: process.execPath,
        entry: finalEntry,
        entry_sha256: createHash('sha256').update(readFileSync(finalEntry)).digest('hex'),
        bundle_sha256: createHash('sha256')
          .update(readFileSync(join(packageRoot, 'dist/pnpm.mjs')))
          .digest('hex'),
        passed: managerPassed,
      })}`
    );
    if (!managerPassed) process.exitCode = 1;
  } catch (error) {
    console.error(
      '[pages-package-manager] Unable to verify the final JavaScript package entry',
      error
    );
    process.exitCode = 1;
  }
});
