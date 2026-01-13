/**
 * SRI Manifest Generator
 *
 * Generates a Subresource Integrity (SRI) manifest for all CDN dependencies.
 * Fetches each dependency from multiple CDN providers, computes SHA-384 hashes,
 * and writes the manifest to public/cdn-integrity.json.
 *
 * The manifest is used by the service worker to verify the integrity of CDN resources
 * before caching, protecting against compromised or tampered CDN content.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

interface CDNEntry {
	url: string;
	integrity: string;
	size: number;
}

interface ManifestEntry {
	'esm.sh': CDNEntry;
	jsdelivr: CDNEntry;
	unpkg: CDNEntry;
	skypack?: CDNEntry;
}

interface SRIManifest {
	version: string;
	generated: string;
	entries: Record<string, ManifestEntry>;
}

/**
 * CDN provider configurations
 */
const CDN_PROVIDERS = {
	'esm.sh': {
		name: 'esm.sh',
		buildUrl: (pkg: string, version: string, subpath = '') => {
			const cleanSubpath = subpath ? (subpath.startsWith('/') ? subpath : `/${subpath}`) : '';
			return `https://esm.sh/${pkg}@${version}${cleanSubpath}?target=esnext`;
		},
	},
	jsdelivr: {
		name: 'jsdelivr',
		buildUrl: (pkg: string, version: string, subpath = '') => {
			const cleanSubpath = subpath ? (subpath.startsWith('/') ? subpath : `/${subpath}`) : '';
			// jsdelivr expects /npm/ prefix and /+esm suffix for ESM modules
			return `https://cdn.jsdelivr.net/npm/${pkg}@${version}${cleanSubpath}/+esm`;
		},
	},
	unpkg: {
		name: 'unpkg',
		buildUrl: (pkg: string, version: string, subpath = '') => {
			const cleanSubpath = subpath ? (subpath.startsWith('/') ? subpath : `/${subpath}`) : '';
			// unpkg serves ESM from ?module query parameter
			return `https://unpkg.com/${pkg}@${version}${cleanSubpath}?module`;
		},
	},
	skypack: {
		name: 'skypack',
		buildUrl: (pkg: string, version: string, subpath = '') => {
			const cleanSubpath = subpath ? (subpath.startsWith('/') ? subpath : `/${subpath}`) : '';
			return `https://cdn.skypack.dev/${pkg}@${version}${cleanSubpath}`;
		},
	},
} as const;

/**
 * Solid.js subpath exports that need separate SRI entries
 * These are commonly used and should be preloaded
 */
const SOLID_JS_SUBPATHS = ['', '/web', '/store', '/h', '/html'];

/**
 * Reads runtime dependencies from package.json
 */
function readRuntimeDependencies(): Record<string, string> {
	const pkgJsonPath = path.join(process.cwd(), 'package.json');
	const raw = readFileSync(pkgJsonPath, 'utf-8');

	// biome-ignore lint/suspicious/noExplicitAny: package.json is untyped external input
	const pkg = JSON.parse(raw) as any;
	const deps = (pkg?.dependencies ?? {}) as Record<string, string>;

	const normalized: Record<string, string> = {};
	for (const [name, spec] of Object.entries(deps)) {
		const trimmed = String(spec).trim();
		// Strip common range prefixes for concrete versions
		normalized[name] = trimmed.replace(/^[\^~]/, '');
	}

	return normalized;
}

/**
 * Fetches a URL and computes its SHA-384 integrity hash
 */
async function fetchAndHash(
	url: string,
	timeout = 30000,
): Promise<{ integrity: string; size: number } | null> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				'User-Agent': 'SRI-Generator/1.0.0',
			},
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			console.warn(`  ✗ Failed to fetch ${url}: ${response.status} ${response.statusText}`);
			return null;
		}

		const buffer = await response.arrayBuffer();
		const hash = createHash('sha384').update(Buffer.from(buffer)).digest('base64');
		const integrity = `sha384-${hash}`;

		return {
			integrity,
			size: buffer.byteLength,
		};
	} catch (error) {
		if (error instanceof Error) {
			console.warn(`  ✗ Error fetching ${url}: ${error.message}`);
		}
		return null;
	}
}

/**
 * Generates SRI entries for a single dependency across all CDN providers
 */
async function generateEntryForDependency(
	pkg: string,
	version: string,
	subpath = '',
): Promise<ManifestEntry | null> {
	const fullPkg = subpath ? `${pkg}${subpath}` : pkg;
	console.log(`\nProcessing: ${fullPkg}@${version}`);

	const entry: Partial<ManifestEntry> = {};

	// Fetch from all CDN providers
	for (const [providerKey, provider] of Object.entries(CDN_PROVIDERS)) {
		const url = provider.buildUrl(pkg, version, subpath);
		console.log(`  Fetching from ${provider.name}...`);

		const result = await fetchAndHash(url);
		if (result) {
			entry[providerKey as keyof ManifestEntry] = {
				url,
				integrity: result.integrity,
				size: result.size,
			};
			console.log(`  ✓ ${provider.name}: ${result.integrity} (${result.size} bytes)`);
		}
	}

	// Require at least primary CDN (esm.sh) to succeed
	if (!entry['esm.sh']) {
		console.error(`  ✗ Failed to fetch from primary CDN (esm.sh), skipping ${fullPkg}`);
		return null;
	}

	return entry as ManifestEntry;
}

/**
 * Main generator function
 */
async function generateSRIManifest() {
	console.log('=== SRI Manifest Generator ===\n');

	const runtimeDeps = readRuntimeDependencies();
	console.log(`Found ${Object.keys(runtimeDeps).length} runtime dependencies\n`);

	const manifest: SRIManifest = {
		version: '1.0.0',
		generated: new Date().toISOString(),
		entries: {},
	};

	// Process each dependency
	for (const [pkg, version] of Object.entries(runtimeDeps)) {
		// Special handling for solid-js subpaths
		if (pkg === 'solid-js') {
			for (const subpath of SOLID_JS_SUBPATHS) {
				const key = subpath ? `${pkg}${subpath}` : pkg;
				const entry = await generateEntryForDependency(pkg, version, subpath);
				if (entry) {
					manifest.entries[key] = entry;
				}
			}
		} else {
			// Regular dependency
			const entry = await generateEntryForDependency(pkg, version);
			if (entry) {
				manifest.entries[pkg] = entry;
			}
		}
	}

	// Write manifest to public/cdn-integrity.json
	const publicDir = path.join(process.cwd(), 'public');
	mkdirSync(publicDir, { recursive: true });

	const manifestPath = path.join(publicDir, 'cdn-integrity.json');
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

	console.log(`\n=== Summary ===`);
	console.log(`Total entries: ${Object.keys(manifest.entries).length}`);
	console.log(`Manifest written to: ${manifestPath}`);
	console.log(`Generated at: ${manifest.generated}`);
	console.log('\n✓ SRI manifest generation complete!');
}

// Run the generator
generateSRIManifest().catch((error) => {
	console.error('\n✗ Fatal error during SRI manifest generation:', error);
	process.exit(1);
});
