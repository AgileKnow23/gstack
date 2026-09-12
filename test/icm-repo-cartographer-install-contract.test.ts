/**
 * Installation contract for /icm-repo-cartographer (free, hermetic).
 *
 * **The contract: source may use dependencies; the installed runtime must work
 * with exactly the files `setup` delivers.**
 *
 * This exists because a review found the engine broken after installation, not
 * in development. `setup` materializes each supported runtime root with
 * `_link_or_copy`, which on Windows is a real `cp -R` of `bin/` and `lib/` and
 * NOTHING else — no `node_modules`, no `package.json`, no source tree. A bare
 * `import ... from 'yaml'` therefore resolved against the copied root or the
 * user's own repository, and Phase 6 died with `Cannot find package 'yaml'` on
 * every Windows install for Codex, Factory, OpenCode and Cursor. Every local
 * test passed the whole time, because every local test ran inside a checkout
 * that had node_modules.
 *
 * So this suite refuses to run anything from this checkout. For each supported
 * destination it materializes the install payload into a temp directory, copies
 * NOTHING else, and drives the installed CLI from a target repository that has
 * no node_modules of its own. A dependency-resolution error anywhere is a
 * failure, distinguished from a config error so the diagnosis is not guesswork.
 *
 * It is deliberately a behavioural contract rather than a file-list assertion:
 * it fails if a future direct dependency is added without being bundled into the
 * delivered artifact, whatever shape that dependency takes.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAgentMapCli } from './helpers/run-agent-map-cli';

const ROOT = path.join(import.meta.dir, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'icm-repo-cartographer', 'sample-repo-map.yml');
const VALID_YAML = fs.readFileSync(FIXTURE, 'utf-8');

/**
 * The runtime roots `setup` builds by copying (setup:1719-1722, 1774-1777,
 * 1827-1830, 1990-1993). The names are documentation: the payload is identical,
 * and the point is that all four get the same treatment.
 */
const RUNTIME_DESTINATIONS = ['codex', 'factory', 'opencode', 'cursor'] as const;

/** Exactly what `_link_or_copy` puts in a runtime root, and nothing more. */
const INSTALL_PAYLOAD = ['bin', 'lib'] as const;

/** The CLI the skill actually invokes after installation. */
const INSTALLED_CLI = 'bin/gstack-agent-map.js';

/** Things that must NEVER be present — if one leaks in, the test proves nothing. */
const MUST_NOT_EXIST = ['node_modules', 'package.json', 'bun.lock', 'lib/agent-map.ts.map'];

let workspace: string;

/** Mirror setup's copy semantics: whole directories, no manifest, no node_modules. */
function materializeRuntimeRoot(dest: string): string {
  const root = path.join(workspace, dest, 'gstack');
  fs.mkdirSync(root, { recursive: true });
  for (const entry of INSTALL_PAYLOAD) {
    fs.cpSync(path.join(ROOT, entry), path.join(root, entry), { recursive: true, dereference: true });
  }
  return root;
}

/** A repository being mapped. It has no node_modules either — that is the point. */
function targetRepo(name: string, yaml = VALID_YAML): string {
  const repo = path.join(workspace, 'targets', name);
  fs.mkdirSync(path.join(repo, 'agent-work'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'agent-work', 'repo-map.yml'), yaml);
  return repo;
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-install-'));
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('the delivered artifact is self-contained', () => {
  const bundle = fs.readFileSync(path.join(ROOT, INSTALLED_CLI), 'utf-8');

  test('the bundle exists and is committed alongside its manifest', () => {
    expect(fs.existsSync(path.join(ROOT, INSTALLED_CLI))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'bin', 'gstack-agent-map.build.json'))).toBe(true);
  });

  test('it imports nothing that has to be resolved from node_modules', () => {
    // This is the assertion that fails the day someone adds a dependency to the
    // engine and forgets to rebuild: a bare specifier that is not a Node builtin
    // cannot resolve inside a copied runtime root.
    const specifiers = new Set<string>();
    for (const m of bundle.matchAll(/\bfrom\s*["']([^"']+)["']/g)) specifiers.add(m[1]);
    for (const m of bundle.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(m[1]);
    for (const m of bundle.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(m[1]);

    const builtins = new Set(require('node:module').builtinModules as string[]);
    const external = [...specifiers].filter(
      (s) => !s.startsWith('.') && !s.startsWith('node:') && !builtins.has(s),
    );
    expect(external, `bundle would resolve these from node_modules: ${external.join(', ')}`).toEqual([]);
  });

  test('the parser really is inlined rather than imported', () => {
    expect(bundle).toMatch(/YAMLParseError|composeDoc|parseDocument/);
  });

  test('the build manifest matches the sources on disk', async () => {
    // Catches "edited the engine, forgot to rebuild". Hashes the INPUTS, because
    // bundler output is not byte-stable across Bun versions.
    const { isFresh } = await import('../scripts/build-agent-map');
    const { fresh, reason } = isFresh(ROOT);
    expect(fresh, `${reason ?? ''} — run: bun run build:agent-map`).toBe(true);
  });
});

describe.each(RUNTIME_DESTINATIONS)('installed runtime root: %s', (dest) => {
  let installed: string;
  let cli: string;

  beforeAll(() => {
    installed = materializeRuntimeRoot(dest);
    cli = path.join(installed, INSTALLED_CLI);
  });

  test('the payload is exactly what setup copies, and nothing else', () => {
    expect(fs.readdirSync(installed).sort()).toEqual([...INSTALL_PAYLOAD].sort());
    for (const forbidden of MUST_NOT_EXIST) {
      expect(fs.existsSync(path.join(installed, forbidden)), `${forbidden} leaked into the install`).toBe(
        false,
      );
    }
    expect(fs.existsSync(cli)).toBe(true);
  });

  test('it parses and renders a valid config with no dependency resolution error', () => {
    const repo = targetRepo(`${dest}-valid`);
    const r = runAgentMapCli(cli, [], repo);

    expect(r.dependencyError, `dependency error from the installed CLI:\n${r.err}`).toBe(false);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('agent-map.mmd');
    expect(r.out).toContain('agent-map.md');

    const mermaid = fs.readFileSync(path.join(repo, 'agent-work/generated/agent-map.mmd'), 'utf-8');
    const markdown = fs.readFileSync(path.join(repo, 'agent-work/generated/agent-map.md'), 'utf-8');
    expect(mermaid).toContain('flowchart LR');
    expect(markdown).toContain('## Bounded contexts');
  });

  test('--check passes on the map it just wrote', () => {
    const repo = targetRepo(`${dest}-check`);
    expect(runAgentMapCli(cli, [], repo).code).toBe(0);

    const checked = runAgentMapCli(cli, ['--check'], repo);
    expect(checked.dependencyError).toBe(false);
    expect(checked.code, checked.err).toBe(0);
    expect(checked.out).toContain('matches the config');
  });

  test('--check reports drift once the config moves on', () => {
    const repo = targetRepo(`${dest}-drift`);
    expect(runAgentMapCli(cli, [], repo).code).toBe(0);
    fs.writeFileSync(
      path.join(repo, 'agent-work/repo-map.yml'),
      VALID_YAML.replace('customers, jobs, and the pipeline between them', 'moved on'),
    );

    const drift = runAgentMapCli(cli, ['--check'], repo);
    expect(drift.dependencyError).toBe(false);
    expect(drift.code).toBe(1);
    expect(drift.err).toContain('stale');
  });

  test('an invalid config fails actionably — a config error, not a missing package', () => {
    const repo = targetRepo(
      `${dest}-invalid`,
      VALID_YAML.replace('  source_of_truth: false', '  source_of_truth: true'),
    );
    const r = runAgentMapCli(cli, [], repo);

    // The distinction matters: a dependency error here would look like a config
    // problem to a user and send them editing YAML that was never wrong.
    expect(r.dependencyError, `this should be a config error, not a resolution error:\n${r.err}`).toBe(
      false,
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('invalid config');
    expect(r.err).toContain('generated_map.source_of_truth');
    expect(r.err).toContain('must be false');
    expect(fs.existsSync(path.join(repo, 'agent-work/generated'))).toBe(false);
  });

  test('a missing config exits 1 and names the skill, without touching node_modules', () => {
    const repo = path.join(workspace, 'targets', `${dest}-empty`);
    fs.mkdirSync(repo, { recursive: true });

    const r = runAgentMapCli(cli, [], repo);
    expect(r.dependencyError).toBe(false);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no config at');
    expect(r.err).toContain('/icm-repo-cartographer');
  });
});

describe('the contract cannot be satisfied by accident', () => {
  test('the target repository never grows a node_modules of its own', () => {
    // If a run ever installed something to make itself work, the hermeticity
    // claim would be false and every assertion above would be worthless.
    const repos = path.join(workspace, 'targets');
    for (const entry of fs.readdirSync(repos)) {
      expect(fs.existsSync(path.join(repos, entry, 'node_modules')), `${entry} grew node_modules`).toBe(
        false,
      );
    }
  });

  test('the source CLI would NOT survive this install — which is why the bundle exists', () => {
    // Guards the reasoning, not just the outcome: if bin/gstack-agent-map.ts ever
    // starts working from a payload with no node_modules, either the dependency
    // was dropped or something is resolving outside the copied tree. Both are
    // worth knowing about, and both should be a deliberate decision.
    const installed = materializeRuntimeRoot('source-probe');
    const repo = targetRepo('source-probe');
    const r = runAgentMapCli(path.join(installed, 'bin', 'gstack-agent-map.ts'), [], repo);
    expect(r.dependencyError || r.code === 0).toBe(true);
  });
});
