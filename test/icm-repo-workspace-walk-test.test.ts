/**
 * /icm-repo-workspace ICM walk test (free, hermetic).
 *
 * The walk test is the skill's validation gate, so it has to be more than a
 * paragraph telling an agent to be careful. This materializes a real workspace in
 * a temp directory — five repo-agnostic templates copied verbatim, plus one filled
 * `repo-map.yml` from the fixture — and then walks it the way a cold agent would:
 * opening files, one at a time, counting reads.
 *
 * What it proves:
 *   1. A cold agent answers all four questions within the entry file plus at most
 *      two more reads.
 *   2. The engine/configuration split is real — the only file carrying project
 *      facts is `repo-map.yml`. Swap that one file and the same scaffold describes
 *      a different repository.
 *   3. The structural checks the skill runs at Phase 6 actually catch what they
 *      claim to (a missing source-of-truth path, a router that outgrew 60 lines).
 *
 * The negative cases matter as much as the positive one: a walk test that cannot
 * fail is a walk test that proves nothing.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.join(import.meta.dir, '..');
const TEMPLATES = path.join(ROOT, 'icm-repo-workspace', 'templates');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'icm-repo-workspace', 'outcome-focus-repo-map.yml');

const REPO_NAME = 'outcome-focus';
const SUMMARY =
  'Multi-tenant CRM and automation platform for service businesses; ships as a web app.';

let workspace: string;

/** Materialize the scaffold exactly as Phase 4 would: copy, substitute, drop in the config. */
function scaffold(dir: string): void {
  const copy = (tmpl: string, dest: string) => {
    const body = fs
      .readFileSync(path.join(TEMPLATES, tmpl), 'utf-8')
      .replaceAll('{REPO_NAME}', REPO_NAME)
      .replaceAll('{ONE_SENTENCE_WHAT_THIS_REPO_IS_AND_WHAT_SHIPS_OUT_OF_IT}', SUMMARY);
    fs.mkdirSync(path.dirname(path.join(dir, dest)), { recursive: true });
    fs.writeFileSync(path.join(dir, dest), body);
  };

  copy('AGENTS.md.template', 'AGENTS.md');
  copy('CLAUDE.md.template', 'CLAUDE.md');
  copy('CONTEXT.md.template', 'agent-work/CONTEXT.md');
  copy('skill-routing.md.template', 'agent-work/_system/skill-routing.md');
  copy('task-brief.md.template', 'agent-work/_templates/task-brief.md');

  // The one project-specific file. Everything above is byte-identical in every repo.
  fs.mkdirSync(path.join(dir, 'agent-work'), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(dir, 'agent-work', 'repo-map.yml'));
}

/**
 * A cold agent: no memory, no prior session, reads files and counts them.
 * `reads` excludes the entry file, which is read 0 by definition.
 */
class ColdAgent {
  readonly reads: string[] = [];
  constructor(private readonly dir: string) {}

  entry(): string {
    return fs.readFileSync(path.join(this.dir, 'AGENTS.md'), 'utf-8');
  }

  read(rel: string): string {
    this.reads.push(rel);
    return fs.readFileSync(path.join(this.dir, rel), 'utf-8');
  }

  readYaml(rel: string): Record<string, any> {
    return Bun.YAML.parse(this.read(rel)) as Record<string, any>;
  }
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-walk-'));
  scaffold(workspace);
  // The source-of-truth documents the fixture names must exist for the walk to
  // resolve them, the same way they exist in the real repository.
  const map = Bun.YAML.parse(fs.readFileSync(path.join(workspace, 'agent-work/repo-map.yml'), 'utf-8')) as any;
  for (const src of map.sources_of_truth) {
    const p = path.join(workspace, src.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `# ${src.path}\n`);
  }
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('ICM walk test — a cold agent, entry file plus two reads', () => {
  test('Q1 "where am I" is answered by the entry file alone (read 0)', () => {
    const agent = new ColdAgent(workspace);
    const entry = agent.entry();

    expect(entry).toContain(`# ${REPO_NAME} — agent entry`);
    expect(entry).toContain(SUMMARY);
    expect(agent.reads).toHaveLength(0);
  });

  test('Q2, Q3 and Q4 are answered one read later, from repo-map.yml', () => {
    const agent = new ColdAgent(workspace);
    const entry = agent.entry();

    // The entry file must point at the config rather than restate it.
    expect(entry).toContain('agent-work/repo-map.yml');

    const map = agent.readYaml('agent-work/repo-map.yml');

    // Q2 — the project's source-of-truth documents.
    const sources = map.sources_of_truth as Array<Record<string, string>>;
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0].path).toBe('CLAUDE.md');
    for (const src of sources) {
      expect(src.path, 'every source of truth names a path').toBeTruthy();
      expect(src.holds, `${src.path} must say what question it answers`).toBeTruthy();
      expect(src.read_when, `${src.path} must say when it is worth the tokens`).toBeTruthy();
    }

    // Q3 — the relevant command.
    expect(map.commands.test).toBe('npm run test');
    expect(map.commands.build).toBe('npm run build');
    expect(map.commands.dev_url).toBe('http://localhost:8080');

    // Q4 — the required human gate.
    const deploy = (map.gates as Array<Record<string, unknown>>).find((g) => g.id === 'deploy');
    expect(deploy).toBeDefined();
    expect(deploy!.self_clearable).toBe(false);

    expect(agent.reads).toEqual(['agent-work/repo-map.yml']);
    expect(agent.reads.length, 'all four answers within entry + 2 reads').toBeLessThanOrEqual(2);
  });

  test('the routing question resolves within the same budget', () => {
    const agent = new ColdAgent(workspace);
    const entry = agent.entry();
    expect(entry).toContain('agent-work/_system/skill-routing.md');

    const routing = agent.read('agent-work/_system/skill-routing.md');
    expect(routing).toMatch(/by risk, never by ritual/i);
    expect(routing).toMatch(/STOP\. Explicit user authorization, every time/);

    expect(agent.reads.length).toBeLessThanOrEqual(2);
  });

  test('every source-of-truth path resolves to a file that exists', () => {
    const map = Bun.YAML.parse(
      fs.readFileSync(path.join(workspace, 'agent-work/repo-map.yml'), 'utf-8'),
    ) as any;
    const missing = (map.sources_of_truth as Array<{ path: string }>)
      .map((s) => s.path)
      .filter((p) => !fs.existsSync(path.join(workspace, p)));
    expect(missing, `sources_of_truth pointing at nothing: ${missing.join(', ')}`).toEqual([]);
  });

  test('the router stayed under 60 lines after substitution', () => {
    const entry = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8');
    expect(entry.split('\n').length).toBeLessThan(60);
  });
});

describe('ICM walk test — the checks can actually fail', () => {
  test('a source-of-truth path pointing at nothing is caught', () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-walk-broken-'));
    try {
      scaffold(broken);
      // Deliberately do NOT create the documents. Every path should now be missing.
      const map = Bun.YAML.parse(
        fs.readFileSync(path.join(broken, 'agent-work/repo-map.yml'), 'utf-8'),
      ) as any;
      const missing = (map.sources_of_truth as Array<{ path: string }>)
        .map((s) => s.path)
        .filter((p) => !fs.existsSync(path.join(broken, p)));
      expect(missing.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
    }
  });

  test('a router that outgrows 60 lines is caught', () => {
    const bloated = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-walk-bloat-'));
    try {
      scaffold(bloated);
      const p = path.join(bloated, 'AGENTS.md');
      fs.appendFileSync(p, '\n'.repeat(40) + 'content that belongs in repo-map.yml\n');
      expect(fs.readFileSync(p, 'utf-8').split('\n').length).toBeGreaterThanOrEqual(60);
    } finally {
      fs.rmSync(bloated, { recursive: true, force: true });
    }
  });
});

describe('one reusable engine, one project-specific configuration file', () => {
  test('the five repo-agnostic files are copied verbatim apart from the two entry placeholders', () => {
    // CONTEXT.md, skill-routing.md and task-brief.md take no substitutions at all:
    // byte-identical to the shipped template in every repository that uses them.
    const pairs: Array<[string, string]> = [
      ['CONTEXT.md.template', 'agent-work/CONTEXT.md'],
      ['skill-routing.md.template', 'agent-work/_system/skill-routing.md'],
      ['task-brief.md.template', 'agent-work/_templates/task-brief.md'],
    ];
    for (const [tmpl, dest] of pairs) {
      expect(fs.readFileSync(path.join(workspace, dest), 'utf-8')).toBe(
        fs.readFileSync(path.join(TEMPLATES, tmpl), 'utf-8'),
      );
    }
  });

  test('no repo-agnostic file names the pilot repository', () => {
    for (const rel of [
      'agent-work/CONTEXT.md',
      'agent-work/_system/skill-routing.md',
      'agent-work/_templates/task-brief.md',
    ]) {
      const body = fs.readFileSync(path.join(workspace, rel), 'utf-8');
      expect(body, `${rel} leaked a project fact`).not.toContain(REPO_NAME);
      expect(body).not.toContain('supabase');
    }
  });

  test('swapping only repo-map.yml re-describes the workspace for a different repo', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-walk-other-'));
    try {
      scaffold(other);
      const swapped = {
        schema: 'icm-repo-workspace/v1',
        repo: { name: 'some-other-repo', form: 'pipeline', entry: 'AGENTS.md' },
        sources_of_truth: [{ path: 'README.md', holds: 'everything', read_when: 'always' }],
        domains: [{ name: 'only', paths: ['src'], risk: [] }],
        commands: { install: 'uv sync', test: 'pytest', dev_url: null },
        gates: [
          {
            id: 'deploy',
            when: 'any release',
            requires: 'explicit user authorization, every time — prior approval never carries forward',
            self_clearable: false,
          },
        ],
        risk_markers: { tenant_isolation: [], auth: [], billing: [], externally_reachable: [] },
        routing_overrides: [],
      };
      fs.writeFileSync(
        path.join(other, 'agent-work/repo-map.yml'),
        JSON.stringify(swapped, null, 2), // JSON is valid YAML
      );

      const agent = new ColdAgent(other);
      agent.entry();
      const map = agent.readYaml('agent-work/repo-map.yml');

      expect(map.repo.name).toBe('some-other-repo');
      expect(map.commands.test).toBe('pytest');
      // dev_url null is load-bearing: this is the repo where browser QA is skipped.
      expect(map.commands.dev_url).toBeNull();
      expect(agent.reads.length).toBeLessThanOrEqual(2);

      // The routing file did not change, because it never held project facts.
      expect(fs.readFileSync(path.join(other, 'agent-work/_system/skill-routing.md'), 'utf-8')).toBe(
        fs.readFileSync(path.join(TEMPLATES, 'skill-routing.md.template'), 'utf-8'),
      );
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
