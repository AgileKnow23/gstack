/**
 * Output-path boundary for /icm-repo-cartographer (free, hermetic).
 *
 * Lexical containment was not enough. `path.resolve` and `path.relative` work on
 * strings, so a checked-out repository that already contains
 * `agent-work/generated/agent-map.mmd` as a symlink still classified as "inside"
 * the output directory, and the write followed the link. A repository could
 * redirect generation at any user-writable file.
 *
 * Every symlink case below asserts the same three things, because the exit code
 * alone proves nothing: the run FAILS, the sentinel outside the workspace is
 * BYTE-IDENTICAL afterwards, and no generated output appeared. The one that
 * matters most is the dangling-symlink case: a guard written with `stat` or
 * `existsSync` would decide that path does not exist and sail straight through.
 * Only `lstat` sees the link itself, and seeing the link is the whole point —
 * resolving it to decide whether resolving it is safe is the bug.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAgentMapCli } from './helpers/run-agent-map-cli';
import {
  resolveOutputPlan,
  assertNoSymlinkOnPath,
  writeGeneratedFile,
  OutputPathError,
} from '../lib/agent-map-output';

const ROOT = path.join(import.meta.dir, '..');
/** The installed artifact, so these properties are proven on what users actually run. */
const CLI = path.join(ROOT, 'bin', 'gstack-agent-map.js');
const YAML = fs.readFileSync(
  path.join(ROOT, 'test', 'fixtures', 'icm-repo-cartographer', 'sample-repo-map.yml'),
  'utf-8',
);

const SENTINEL_BODY = '# untouched — nothing may write here\n';

/**
 * Windows needs Developer Mode or elevation to create symlinks. Probe once rather
 * than guess: a skipped test that looks like a pass is worse than a loud skip.
 */
function symlinksAvailable(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-symprobe-'));
  try {
    const target = path.join(dir, 'target');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SYMLINKS = symlinksAvailable();

interface Fixture {
  /** Temp root: holds the sentinel and the repo side by side. */
  dir: string;
  /** The repository being mapped. */
  repo: string;
  /** A file outside the output directory that must never be touched. */
  sentinel: string;
  agentWork: string;
  generated: string;
  mermaidTarget: string;
  markdownTarget: string;
}

const made: string[] = [];

function fixture(yaml = YAML): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-outpath-'));
  made.push(dir);
  const sentinel = path.join(dir, 'SENTINEL.txt');
  fs.writeFileSync(sentinel, SENTINEL_BODY);

  const repo = path.join(dir, 'repo');
  const agentWork = path.join(repo, 'agent-work');
  fs.mkdirSync(agentWork, { recursive: true });
  fs.writeFileSync(path.join(agentWork, 'repo-map.yml'), yaml);

  const generated = path.join(agentWork, 'generated');
  return {
    dir,
    repo,
    sentinel,
    agentWork,
    generated,
    mermaidTarget: path.join(generated, 'agent-map.mmd'),
    markdownTarget: path.join(generated, 'agent-map.md'),
  };
}

/** Every symlink rejection must satisfy all three, not just the exit code. */
function expectRefusedAndIntact(f: Fixture, args: string[] = []): string {
  const r = runAgentMapCli(CLI, args, f.repo);
  expect(r.code, `expected a refusal, got exit ${r.code}\n${r.err}`).toBe(2);
  expect(r.err).toContain('refusing to use a symlinked path component');
  expect(fs.readFileSync(f.sentinel, 'utf-8'), 'the sentinel was modified').toBe(SENTINEL_BODY);
  return r.err;
}

afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the boundary refuses symlinked output components', () => {
  test.skipIf(!SYMLINKS)('an existing Mermaid target that is a symlink outside the output dir', () => {
    const f = fixture();
    fs.mkdirSync(f.generated, { recursive: true });
    fs.symlinkSync(f.sentinel, f.mermaidTarget, 'file');

    const err = expectRefusedAndIntact(f);
    expect(err).toContain('agent-map.mmd');
    expect(err).toMatch(/deliberately not resolved/i);
    // Only the link is present; no real artifact was produced beside it.
    expect(fs.readdirSync(f.generated).sort()).toEqual(['agent-map.mmd']);
    expect(fs.lstatSync(f.mermaidTarget).isSymbolicLink()).toBe(true);
  });

  test.skipIf(!SYMLINKS)('an existing Markdown target that is a symlink outside the output dir', () => {
    const f = fixture();
    fs.mkdirSync(f.generated, { recursive: true });
    fs.symlinkSync(f.sentinel, f.markdownTarget, 'file');

    const err = expectRefusedAndIntact(f);
    expect(err).toContain('agent-map.md');
    expect(fs.readdirSync(f.generated).sort()).toEqual(['agent-map.md']);
  });

  test.skipIf(!SYMLINKS)('the generated directory itself is a symlink outside the workspace', () => {
    const f = fixture();
    const outside = path.join(f.dir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, f.generated, 'dir');

    expectRefusedAndIntact(f);
    // Nothing was written through the link into the outside directory.
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test.skipIf(!SYMLINKS)('an intermediate component — agent-work — is a symlink', () => {
    // agent-work is where the config lives, so this is the sharpest intermediate
    // case: the walk must judge it even though it was traversed to find the config.
    const f = fixture();
    const real = path.join(f.dir, 'elsewhere-agent-work');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'repo-map.yml'), YAML);
    fs.rmSync(f.agentWork, { recursive: true, force: true });
    fs.symlinkSync(real, f.agentWork, 'dir');

    const err = expectRefusedAndIntact(f);
    expect(err).toContain('agent-work');
    expect(fs.existsSync(path.join(real, 'generated'))).toBe(false);
  });

  test.skipIf(!SYMLINKS)('--check refuses the symlink before it reads the target', () => {
    const f = fixture();
    fs.mkdirSync(f.generated, { recursive: true });
    fs.symlinkSync(f.sentinel, f.mermaidTarget, 'file');

    // Exit 2 (invalid), never 0 (matches) or 1 (drift): a --check that followed
    // the link would compare the sentinel's bytes and report about a file
    // somewhere else entirely.
    const err = expectRefusedAndIntact(f, ['--check']);
    expect(err).toContain('agent-map.mmd');
  });

  test.skipIf(!SYMLINKS)('a DANGLING symlink is still refused — proof the check never resolves', () => {
    const f = fixture();
    fs.mkdirSync(f.generated, { recursive: true });
    fs.symlinkSync(path.join(f.dir, 'does-not-exist.txt'), f.mermaidTarget, 'file');

    // `stat` and `existsSync` both report false here, so a guard built on either
    // would treat the path as free and write straight through the link.
    expect(fs.existsSync(f.mermaidTarget)).toBe(false);
    const err = expectRefusedAndIntact(f);
    expect(err).toContain('agent-map.mmd');
  });
});

describe('ordinary output still works', () => {
  test('a clean repository renders both artifacts and --check passes', () => {
    const f = fixture();

    const wrote = runAgentMapCli(CLI, [], f.repo);
    expect(wrote.code, wrote.err).toBe(0);
    expect(wrote.out).toContain('agent-map.mmd');
    expect(wrote.out).toContain('agent-map.md');

    expect(fs.readFileSync(f.mermaidTarget, 'utf-8')).toContain('flowchart LR');
    expect(fs.readFileSync(f.markdownTarget, 'utf-8')).toContain('## Bounded contexts');

    const checked = runAgentMapCli(CLI, ['--check'], f.repo);
    expect(checked.code, checked.err).toBe(0);
    expect(checked.out).toContain('matches the config');
  });

  test('the written targets are regular files, and no temp file is left behind', () => {
    const f = fixture();
    expect(runAgentMapCli(CLI, [], f.repo).code).toBe(0);

    for (const target of [f.mermaidTarget, f.markdownTarget]) {
      const info = fs.lstatSync(target);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.isFile()).toBe(true);
    }
    // The atomic write renders to a temp name and renames; a leftover would mean
    // a failure path swallowed an error.
    expect(fs.readdirSync(f.generated).filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(fs.readdirSync(f.generated).sort()).toEqual(['agent-map.md', 'agent-map.mmd']);
  });

  test('re-running over existing regular files replaces them cleanly', () => {
    const f = fixture();
    expect(runAgentMapCli(CLI, [], f.repo).code).toBe(0);
    const before = fs.readFileSync(f.markdownTarget, 'utf-8');
    expect(runAgentMapCli(CLI, [], f.repo).code).toBe(0);
    expect(fs.readFileSync(f.markdownTarget, 'utf-8')).toBe(before);
    expect(fs.readdirSync(f.generated).sort()).toEqual(['agent-map.md', 'agent-map.mmd']);
  });
});

describe('the config cannot direct writes anywhere', () => {
  // Both live findings came from letting a checked-in file choose destinations
  // and filenames. The fields are gone, so these are parse failures now rather
  // than path-validation outcomes — and a parse failure happens before mkdir.
  const retired: Array<[string, string, string]> = [
    ['output_dir', 'output_dir: ../victim', 'generated_map.output_dir'],
    ['mermaid', 'mermaid: evil.mmd', 'generated_map.mermaid'],
    ['markdown', 'markdown: evil.md', 'generated_map.markdown'],
  ];

  test.each(retired)('generated_map.%s in a checked-in config fails the parse', (_name, line, field) => {
    const f = fixture(YAML.replace('  direction: LR', `  direction: LR\n  ${line}`));

    const r = runAgentMapCli(CLI, [], f.repo);
    expect(r.code).toBe(2);
    expect(r.err).toContain('invalid config');
    expect(r.err).toContain(field);
    expect(r.err).toMatch(/remove it/i);
    expect(r.err).toMatch(/fixed tool policy/i);
    // Rejected before anything is created, and the sentinel outside is untouched.
    expect(fs.existsSync(f.generated)).toBe(false);
    expect(fs.readFileSync(f.sentinel, 'utf-8')).toBe(SENTINEL_BODY);
  });

  test('output_dir pointing at a sibling directory cannot overwrite regular files', () => {
    // The exact reported scenario: two ordinary regular files in a sibling
    // directory, no symlink involved anywhere.
    const f = fixture(YAML.replace('  direction: LR', '  direction: LR\n  output_dir: ../victim'));
    const victim = path.join(f.repo, '..', 'victim');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'agent-map.mmd'), 'VICTIM-1\n');
    fs.writeFileSync(path.join(victim, 'agent-map.md'), 'VICTIM-2\n');

    const r = runAgentMapCli(CLI, [], f.repo);
    expect(r.code).toBe(2);
    expect(fs.readFileSync(path.join(victim, 'agent-map.mmd'), 'utf-8')).toBe('VICTIM-1\n');
    expect(fs.readFileSync(path.join(victim, 'agent-map.md'), 'utf-8')).toBe('VICTIM-2\n');
    expect(fs.existsSync(f.generated)).toBe(false);
  });

  test('a valid config renders exactly the two fixed canonical files', () => {
    const f = fixture();
    expect(runAgentMapCli(CLI, [], f.repo).code).toBe(0);
    expect(fs.readdirSync(f.generated).sort()).toEqual(['agent-map.md', 'agent-map.mmd']);
  });
});

describe('--out is the only way to write elsewhere, and it is a person asking', () => {
  test('it renders the same two fixed names into the supplied directory', () => {
    const f = fixture();
    const elsewhere = path.join(f.dir, 'elsewhere');

    const r = runAgentMapCli(CLI, ['--out', elsewhere], f.repo);
    expect(r.code, r.err).toBe(0);
    expect(fs.readdirSync(elsewhere).sort()).toEqual(['agent-map.md', 'agent-map.mmd']);
    // The canonical location is untouched: --out redirects, it does not duplicate.
    expect(fs.existsSync(f.generated)).toBe(false);
  });

  test('--check works against the explicit directory too', () => {
    const f = fixture();
    const elsewhere = path.join(f.dir, 'elsewhere-check');
    expect(runAgentMapCli(CLI, ['--out', elsewhere], f.repo).code).toBe(0);
    expect(runAgentMapCli(CLI, ['--out', elsewhere, '--check'], f.repo).code).toBe(0);
  });

  test.skipIf(!SYMLINKS)('the symlink boundary still applies under --out', () => {
    const f = fixture();
    const elsewhere = path.join(f.dir, 'elsewhere-symlink');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(f.sentinel, path.join(elsewhere, 'agent-map.mmd'), 'file');

    const r = runAgentMapCli(CLI, ['--out', elsewhere], f.repo);
    expect(r.code).toBe(2);
    expect(r.err).toContain('refusing to use a symlinked path component');
    expect(fs.readFileSync(f.sentinel, 'utf-8')).toBe(SENTINEL_BODY);
  });

  test.skipIf(!SYMLINKS)('--check under --out refuses a symlink before reading it', () => {
    const f = fixture();
    const elsewhere = path.join(f.dir, 'elsewhere-symlink-check');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(f.sentinel, path.join(elsewhere, 'agent-map.md'), 'file');

    const r = runAgentMapCli(CLI, ['--out', elsewhere, '--check'], f.repo);
    expect(r.code).toBe(2);
    expect(r.err).toContain('refusing to use a symlinked path component');
    expect(fs.readFileSync(f.sentinel, 'utf-8')).toBe(SENTINEL_BODY);
  });
});
describe('the resolver, directly', () => {
  test('it reports the field and the offending component, not a generic message', () => {
    if (!SYMLINKS) return;
    const f = fixture();
    fs.mkdirSync(f.generated, { recursive: true });
    fs.symlinkSync(f.sentinel, f.markdownTarget, 'file');

    let thrown: unknown;
    try {
      resolveOutputPlan({ root: f.repo, outDir: f.generated });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OutputPathError);
    const err = thrown as OutputPathError;
    // The resolver takes no filenames any more — they are policy — so it reports
    // the override a person would reach for instead of a YAML key that is gone.
    expect(err.field).toContain('--out');
    expect(err.field).toContain('agent-map.md');
    expect(err.offendingPath).toBe(f.markdownTarget);
  });

  test('a clean tree resolves to two absolute targets inside the output directory', () => {
    const f = fixture();
    const plan = resolveOutputPlan({ root: f.repo, outDir: f.generated });
    expect(plan.outDir).toBe(path.resolve(f.generated));
    expect(plan.targets.map((t) => path.basename(t.file))).toEqual(['agent-map.mmd', 'agent-map.md']);
    for (const target of plan.targets) {
      expect(path.isAbsolute(target.file)).toBe(true);
      expect(path.relative(plan.outDir, target.file).startsWith('..')).toBe(false);
    }
  });

  test('components at or above the root are not judged — a symlinked temp dir is normal', () => {
    // macOS resolves /tmp through a link and plenty of people symlink $HOME.
    // Judging above the root would refuse ordinary machines while protecting
    // nobody, so the walk starts strictly below it.
    const f = fixture();
    expect(() => assertNoSymlinkOnPath(f.repo, f.mermaidTarget, 'generated_map.mermaid')).not.toThrow();
  });

  test('a non-existent component is fine — that is what mkdir will create', () => {
    const f = fixture();
    expect(fs.existsSync(f.generated)).toBe(false);
    expect(() => assertNoSymlinkOnPath(f.repo, f.mermaidTarget, 'generated_map.mermaid')).not.toThrow();
  });

  test('there is no longer any way to ask for a filename outside the directory', () => {
    // The lexical-escape case used to be reachable by configuring a filename with
    // a separator in it. The resolver no longer accepts filenames at all, so the
    // whole class is gone rather than guarded: both targets are always the two
    // fixed names joined to the directory.
    const f = fixture();
    const plan = resolveOutputPlan({ root: f.repo, outDir: f.generated });
    for (const target of plan.targets) {
      expect(path.dirname(target.file)).toBe(path.resolve(f.generated));
      expect(['agent-map.mmd', 'agent-map.md']).toContain(path.basename(target.file));
    }
  });

  test('writeGeneratedFile refuses to write through a link that appears late', () => {
    if (!SYMLINKS) return;
    const f = fixture();
    fs.mkdirSync(f.generated, { recursive: true });
    // Validation passed, then a link appeared. The rename replaces the entry
    // itself rather than writing through it, so the sentinel survives.
    fs.symlinkSync(f.sentinel, f.mermaidTarget, 'file');

    writeGeneratedFile(f.mermaidTarget, 'replacement\n');

    expect(fs.readFileSync(f.sentinel, 'utf-8')).toBe(SENTINEL_BODY);
    expect(fs.lstatSync(f.mermaidTarget).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(f.mermaidTarget, 'utf-8')).toBe('replacement\n');
  });
});

describe('symlink coverage is reported, not silently skipped', () => {
  test('this environment can create symlinks (otherwise the cases above are skipped)', () => {
    // Deliberately visible: on a Windows box without Developer Mode the symlink
    // cases cannot run, and a green suite would otherwise imply they had.
    if (!SYMLINKS) {
      console.warn(
        'icm-repo-cartographer-output-path: symlink creation unavailable — symlink cases skipped. ' +
          'Linux CI covers them.',
      );
    }
    expect(typeof SYMLINKS).toBe('boolean');
  });
});
