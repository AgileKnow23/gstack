#!/usr/bin/env bun
/**
 * Build the distributable agent-map CLI.
 *
 * Why a bundle exists at all: `setup` delivers runtime roots by copying `bin/`
 * and `lib/` (see `_link_or_copy`) WITHOUT `node_modules` or `package.json`. A
 * bare `import ... from 'yaml'` therefore resolves against the copied root or,
 * worse, the user's own repository — and Phase 6 dies with
 * `Cannot find package 'yaml'` on every Windows install for Codex, Factory,
 * OpenCode and Cursor.
 *
 * The contract this establishes: **source may use dependencies; the installed
 * runtime must work with exactly the files setup delivers.** So the shipped
 * artifact is a single self-contained file with its parser inlined, living in
 * `bin/` where the existing install payload already carries it. No setup change
 * is needed to deliver it, and nothing resolves outside the copied tree.
 *
 * The source files stay ordinary, readable TypeScript — tests import them
 * directly. Nothing here is hand-vendored.
 *
 *   bun run build:agent-map           # rebuild the bundle and its manifest
 *   bun run build:agent-map --check   # exit 1 if the sources moved since the build
 *
 * The manifest records a sha256 per source file rather than hashing the bundle
 * itself: bundler output is not byte-stable across Bun versions (CI pins 1.3.13,
 * contributors run whatever they have), so hashing the INPUTS is the staleness
 * signal that does not flake.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const ENTRY = path.join(ROOT, 'bin', 'gstack-agent-map.ts');
const OUT = path.join(ROOT, 'bin', 'gstack-agent-map.js');
const MANIFEST = path.join(ROOT, 'bin', 'gstack-agent-map.build.json');

/** Everything whose content can change what the bundle does. */
export const BUNDLE_SOURCES = [
  'bin/gstack-agent-map.ts',
  'lib/agent-map.ts',
  'lib/agent-map-output.ts',
];

export function sourceHashes(root = ROOT): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of BUNDLE_SOURCES) {
    const body = fs.readFileSync(path.join(root, rel));
    out[rel] = createHash('sha256').update(body).digest('hex');
  }
  return out;
}

export interface BuildManifest {
  /** How the artifact is produced, so a reader does not have to guess. */
  built_by: string;
  entry: string;
  output: string;
  /** sha256 of each input; the freshness check recomputes and compares these. */
  sources: Record<string, string>;
  /** Bundled dependencies, so a reviewer can see what is inlined. */
  bundled_dependencies: Record<string, string>;
}

function readPackageVersion(name: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  return (pkg.dependencies ?? {})[name] ?? 'unknown';
}

export function buildManifest(): BuildManifest {
  return {
    built_by: 'bun run build:agent-map',
    entry: 'bin/gstack-agent-map.ts',
    output: 'bin/gstack-agent-map.js',
    sources: sourceHashes(),
    bundled_dependencies: { yaml: readPackageVersion('yaml') },
  };
}

/** True when the committed manifest still describes the sources on disk. */
export function isFresh(root = ROOT): { fresh: boolean; reason?: string } {
  const manifestPath = path.join(root, 'bin', 'gstack-agent-map.build.json');
  const bundlePath = path.join(root, 'bin', 'gstack-agent-map.js');
  if (!fs.existsSync(bundlePath)) return { fresh: false, reason: 'bin/gstack-agent-map.js is missing' };
  if (!fs.existsSync(manifestPath)) return { fresh: false, reason: 'bin/gstack-agent-map.build.json is missing' };

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BuildManifest;
  const current = sourceHashes(root);
  for (const rel of BUNDLE_SOURCES) {
    if (manifest.sources?.[rel] !== current[rel]) {
      return { fresh: false, reason: `${rel} changed since the bundle was built` };
    }
  }
  return { fresh: true };
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');

  if (check) {
    const { fresh, reason } = isFresh();
    if (!fresh) {
      console.error(`build-agent-map: bundle is stale — ${reason}.\n  Rebuild: bun run build:agent-map`);
      process.exit(1);
    }
    console.log('build-agent-map: bundle matches its sources');
    return;
  }

  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: 'node',
    format: 'esm',
    minify: false, // readable by whoever has to debug an install
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  const [artifact] = result.outputs;
  const code = await artifact.text();
  fs.writeFileSync(OUT, code);
  fs.writeFileSync(MANIFEST, JSON.stringify(buildManifest(), null, 2) + '\n');

  console.log(`WROTE bin/gstack-agent-map.js (${(code.length / 1024).toFixed(1)} KB)`);
  console.log('WROTE bin/gstack-agent-map.build.json');
}

if (import.meta.main) {
  await main();
}
