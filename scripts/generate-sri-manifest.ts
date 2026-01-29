
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

interface CDNEntry {
  url: string;
  integrity: string;
  size: number;
}

interface ManifestEntry {
  "esm.sh": CDNEntry;
  jsdelivr: CDNEntry;
  unpkg: CDNEntry;
  skypack?: CDNEntry;
}

interface SRIManifest {
  version: string;
  generated: string;
  entries: Record<string, ManifestEntry>;
}

const CDN_PROVIDERS = {
  "esm.sh": {
    name: "esm.sh",
    buildUrl: (pkg: string, version: string, subpath = "") => {
      const cleanSubpath = subpath
        ? subpath.startsWith("/")
          ? subpath
          : `/${subpath}`
        : "";
      return `https://esm.sh/${pkg}@${version}${cleanSubpath}?target=esnext`;
    },
  },
  jsdelivr: {
    name: "jsdelivr",
    buildUrl: (pkg: string, version: string, subpath = "") => {
      const cleanSubpath = subpath
        ? subpath.startsWith("/")
          ? subpath
          : `/${subpath}`
        : "";
      return `https://cdn.jsdelivr.net/npm/${pkg}@${version}${cleanSubpath}/+esm`;
    },
  },
  unpkg: {
    name: "unpkg",
    buildUrl: (pkg: string, version: string, subpath = "") => {
      const cleanSubpath = subpath
        ? subpath.startsWith("/")
          ? subpath
          : `/${subpath}`
        : "";
      return `https://unpkg.com/${pkg}@${version}${cleanSubpath}?module`;
    },
  },
  skypack: {
    name: "skypack",
    buildUrl: (pkg: string, version: string, subpath = "") => {
      const cleanSubpath = subpath
        ? subpath.startsWith("/")
          ? subpath
          : `/${subpath}`
        : "";
      return `https://cdn.skypack.dev/${pkg}@${version}${cleanSubpath}`;
    },
  },
} as const;

const SOLID_JS_SUBPATHS = ["", "/web", "/store", "/h", "/html"];

const getProvidersForDependency = (
  pkg: string,
  subpath: string
): Array<keyof typeof CDN_PROVIDERS> => {
  const providers = Object.keys(CDN_PROVIDERS) as Array<
    keyof typeof CDN_PROVIDERS
  >;

  // unpkg does not expose solid-js subpath modules (404). Skip to avoid warnings.
  if (pkg === "solid-js" && subpath) {
    return providers.filter((provider) => provider !== "unpkg");
  }

  return providers;
};

function readRuntimeDependencies(): Record<string, string> {
  const pkgJsonPath = path.join(process.cwd(), "package.json");
  const raw = readFileSync(pkgJsonPath, "utf-8");

  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    cdnDependencies?: Record<string, string>;
  };
  const deps = pkg?.dependencies ?? {};
  const cdnDeps = pkg?.cdnDependencies ?? {};

  const normalizeVersion = (spec: string): string =>
    String(spec)
      .trim()
      .replace(/^[\^~]/, "");

  const normalized: Record<string, string> = {};
  const addDeps = (source: Record<string, string>, label: string): void => {
    for (const [name, spec] of Object.entries(source)) {
      const version = normalizeVersion(spec);
      const existing = normalized[name];
      if (existing && existing !== version) {
        throw new Error(
          `[sri] Version mismatch for ${name}: ${existing} (previous) vs ${version} (${label})`
        );
      }
      normalized[name] = version;
    }
  };

  addDeps(deps, "dependencies");
  addDeps(cdnDeps, "cdnDependencies");

  return normalized;
}

async function fetchAndHash(
  url: string,
  timeout = 30000
): Promise<{ integrity: string; size: number } | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "SRI-Generator/1.0.0",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(
        `  ✗ Failed to fetch ${url}: ${response.status} ${response.statusText}`
      );
      return null;
    }

    const buffer = await response.arrayBuffer();
    const hash = createHash("sha384")
      .update(Buffer.from(buffer))
      .digest("base64");
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

async function generateEntryForDependency(
  pkg: string,
  version: string,
  subpath = ""
): Promise<ManifestEntry | null> {
  const fullPkg = subpath ? `${pkg}${subpath}` : pkg;
  console.log(`\nProcessing: ${fullPkg}@${version}`);

  const entry: Partial<ManifestEntry> = {};

  const providerKeys = getProvidersForDependency(pkg, subpath);

  for (const providerKey of providerKeys) {
    const provider = CDN_PROVIDERS[providerKey];
    const url = provider.buildUrl(pkg, version, subpath);
    console.log(`  Fetching from ${provider.name}...`);

    const result = await fetchAndHash(url);
    if (result) {
      entry[providerKey as keyof ManifestEntry] = {
        url,
        integrity: result.integrity,
        size: result.size,
      };
      console.log(
        `  ✓ ${provider.name}: ${result.integrity} (${result.size} bytes)`
      );
    }
  }

  if (!entry["esm.sh"]) {
    console.error(
      `  ✗ Failed to fetch from primary CDN (esm.sh), skipping ${fullPkg}`
    );
    return null;
  }

  return entry as ManifestEntry;
}

async function generateSRIManifest() {
  console.log("=== SRI Manifest Generator ===\n");

  const runtimeDeps = readRuntimeDependencies();
  console.log(
    `Found ${Object.keys(runtimeDeps).length} runtime dependencies\n`
  );

  const manifest: SRIManifest = {
    version: "1.0.0",
    generated: new Date().toISOString(),
    entries: {},
  };

  for (const [pkg, version] of Object.entries(runtimeDeps)) {
    if (pkg === "solid-js") {
      for (const subpath of SOLID_JS_SUBPATHS) {
        const key = subpath ? `${pkg}${subpath}` : pkg;
        const entry = await generateEntryForDependency(pkg, version, subpath);
        if (entry) {
          manifest.entries[key] = entry;
        }
      }
    } else {
      const entry = await generateEntryForDependency(pkg, version);
      if (entry) {
        manifest.entries[pkg] = entry;
      }
    }
  }

  const publicDir = path.join(process.cwd(), "public");
  mkdirSync(publicDir, { recursive: true });

  const manifestPath = path.join(publicDir, "cdn-integrity.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  console.log(`\n=== Summary ===`);
  console.log(`Total entries: ${Object.keys(manifest.entries).length}`);
  console.log(`Manifest written to: ${manifestPath}`);
  console.log(`Generated at: ${manifest.generated}`);
  console.log("\n✓ SRI manifest generation complete!");
}

// Run the generator
generateSRIManifest().catch((error) => {
  console.error("\n✗ Fatal error during SRI manifest generation:", error);
  process.exit(1);
});
