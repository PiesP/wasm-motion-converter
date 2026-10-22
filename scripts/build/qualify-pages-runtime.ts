/** Opt-in Pages evidence for the selected Node and native pnpm runtimes. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  'https://ev-g3b-aaa-emudhra.we-have-a-problem.com/',
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
const managerProcess = spawnSync('pnpm', ['exec', 'node', '-p', 'process.env.npm_execpath'], {
  encoding: 'utf8',
  timeout: 15_000,
  stdio: ['ignore', 'pipe', 'inherit'],
});
if (managerProcess.error) throw managerProcess.error;
if (managerProcess.status !== 0) throw new Error('Could not inspect the selected Pages pnpm');
const managerEntry = realpathSync(managerProcess.stdout.trim());
const managerBytes = readFileSync(managerEntry);
let packageRoot = dirname(managerEntry);
let manager: { name?: string; version?: string } | undefined;
for (let depth = 0; depth < 4; depth++) {
  try {
    const candidate = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
    };
    if (candidate.name === 'pnpm') {
      manager = candidate;
      break;
    }
  } catch {
    // Walk only the selected binary's package ancestry.
  }
  packageRoot = dirname(packageRoot);
}
const managerPassed =
  managerBytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
  manager?.name === 'pnpm' &&
  `pnpm@${manager.version}` === manifest.packageManager;
console.error(
  `[pages-package-manager] ${JSON.stringify({
    version: manager?.version ?? null,
    entry: managerEntry,
    binary_sha256: createHash('sha256').update(managerBytes).digest('hex'),
    format: managerBytes.subarray(0, 4).toString('hex'),
    passed: managerPassed,
  })}`
);
if (!managerPassed) throw new Error('Pages native pnpm identity qualification failed');
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
    package_manager: manifest.packageManager,
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
if (!passed) throw new Error('Pages Node TLS qualification failed');
