/**
 * /icm-repo-cartographer ICM walk test (free, hermetic).
 *
 * The walk test is the skill's validation gate, so it has to be more than a
 * paragraph telling an agent to be careful. This materializes a real workspace in
 * a temp directory — five repo-agnostic templates copied verbatim, one filled
 * `repo-map.yml` from the fixture, and two files rendered from that YAML — then
 * walks it the way a cold agent would: opening files, one at a time, counting.
 *
 * What it proves:
 *   1. A minimal sample repository produces a valid, complete adapter.
 *   2. A cold agent answers all four questions within AGENTS.md plus at most two
 *      more reads: where it is, what route applies, which documents and commands
 *      matter, and what human gate applies.
 *   3. The engine/configuration split is real — the only file carrying project
 *      facts is `repo-map.yml`. Swap that one file and the same scaffold describes
 *      a different repository.
 *   4. The generated map is reproducible and never the source of truth.
 *
 * The negative cases matter as much as the positive ones: a walk test that cannot
 * fail is a walk test that proves nothing.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { renderAgentMap, GENERATED_BANNER } from '../lib/agent-map';
import { parse as parseYaml } from 'yaml';

const ROOT = path.join(import.meta.dir, '..');
const TEMPLATES = path.join(ROOT, 'icm-repo-cartographer', 'templates');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'icm-repo-cartographer', 'sample-repo-map.yml');

const REPO_NAME = 'sample-crm';
const SUMMARY = 'A multi-tenant CRM for service businesses; ships as a web app.';

/** The adapter, exactly as Phases 4-6 build it. */
const ADAPTER_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'agent-work/repo-map.yml',
  'agent-work/CONTEXT.md',
  'agent-work/_system/skill-routing.md',
  'agent-work/_templates/task-brief.md',
  'agent-work/generated/agent-map.md',
  'agent-work/generated/agent-map.mmd',
];

let workspace: string;

function scaffold(dir: string, configPath = FIXTURE): void {
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

  // The one project-specific file. Everything above is byte-identical everywhere.
  const yaml = fs.readFileSync(configPath, 'utf-8');
  fs.writeFileSync(path.join(dir, 'agent-work', 'repo-map.yml'), yaml);

  // ...and the two files rendered FROM it.
  const rendered = renderAgentMap(yaml);
  fs.mkdirSync(path.join(dir, 'agent-work', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-work', 'generated', 'agent-map.mmd'), rendered.mermaid);
  fs.writeFileSync(path.join(dir, 'agent-work', 'generated', 'agent-map.md'), rendered.markdown);
}

/**
 * A cold agent: no memory, no prior session, reads files and counts them.
 * `reads` excludes AGENTS.md, which is read 0 by definition.
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
    return parseYaml(this.read(rel)) as Record<string, any>;
  }
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-cart-'));
  scaffold(workspace);
  // The source-of-truth documents the fixture names must exist for the walk to
  // resolve them, the same way they exist in the real repository.
  const map = parseYaml(fs.readFileSync(path.join(workspace, 'agent-work/repo-map.yml'), 'utf-8')) as any;
  for (const src of map.sources_of_truth) {
    const p = path.join(workspace, src.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `# ${src.path}\n`);
  }
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('a minimal sample repository produces a valid adapter', () => {
  test('all eight files exist and none is empty', () => {
    for (const rel of ADAPTER_FILES) {
      const p = path.join(workspace, rel);
      expect(fs.existsSync(p), `${rel} missing`).toBe(true);
      expect(fs.readFileSync(p, 'utf-8').trim().length, `${rel} is empty`).toBeGreaterThan(0);
    }
  });

  test('the repository root gained exactly two files', () => {
    const rootEntries = fs
      .readdirSync(workspace, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
    expect(rootEntries).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  test('no placeholder survived substitution in the entry files', () => {
    for (const rel of ['AGENTS.md', 'CLAUDE.md']) {
      const body = fs.readFileSync(path.join(workspace, rel), 'utf-8');
      expect(body, `${rel} still carries a placeholder`).not.toMatch(/\{[A-Z_]{4,}\}/);
    }
  });

  test('no speculative structure was created', () => {
    const dirs = fs
      .readdirSync(path.join(workspace, 'agent-work'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual(['_system', '_templates', 'generated']);
  });
});

describe('ICM walk test — a cold agent, AGENTS.md plus two reads', () => {
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

    // Q2 — what task route applies.
    const classes = map.task_classes as Array<Record<string, unknown>>;
    expect(classes.length).toBeGreaterThan(0);
    const docsClass = classes.find((c) => c.id === 'docs-or-local-config');
    expect(docsClass!.skill).toBeNull();
    const release = classes.find((c) => c.id === 'release');
    expect(release!.skill).toBe('/ship');
    expect(release!.gate).toBe('deploy');

    // Q3 — which documents and commands matter.
    const sources = map.sources_of_truth as Array<Record<string, string>>;
    expect(sources[0].path).toBe('docs/terminology.md');
    for (const src of sources) {
      expect(src.holds, `${src.path} must say what question it answers`).toBeTruthy();
      expect(src.read_when, `${src.path} must say when it is worth the tokens`).toBeTruthy();
    }
    expect(map.commands.test).toBe('npm run test');
    expect(map.commands.typecheck).toBe('npm run typecheck');
    expect(map.commands.dev_url).toBe('http://localhost:8080');

    // Q4 — what human gate applies.
    const deploy = (map.gates as Array<Record<string, unknown>>).find((g) => g.id === 'deploy');
    expect(deploy).toBeDefined();
    expect(deploy!.authority).toBe('user');
    // Non-self-clearability is structural now: there is no field to read, so the
    // cold agent cannot be told otherwise by the config.
    for (const gate of map.gates as Array<Record<string, unknown>>) {
      expect(Object.keys(gate)).not.toContain('self_clearable');
    }

    expect(agent.reads).toEqual(['agent-work/repo-map.yml']);
    expect(agent.reads.length, 'all four answers within AGENTS.md + 2 reads').toBeLessThanOrEqual(2);
  });

  test('how to APPLY the routing table resolves on the second read', () => {
    const agent = new ColdAgent(workspace);
    const entry = agent.entry();
    expect(entry).toContain('agent-work/_system/skill-routing.md');

    agent.read('agent-work/repo-map.yml');
    const routing = agent.read('agent-work/_system/skill-routing.md');

    expect(routing).toMatch(/by risk and scope, not ceremony/i);
    expect(routing).toMatch(/Never run every skill on every task/i);
    expect(agent.reads.length).toBeLessThanOrEqual(2);
  });

  test('every source-of-truth path resolves to a file that exists', () => {
    const map = parseYaml(
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

  test('no routing content is duplicated between the two entry files', () => {
    const agents = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8');
    const claude = fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf-8');
    for (const heading of agents.match(/^## .+$/gm) ?? []) expect(claude).not.toContain(heading);
    expect(claude.match(/^\|.*\|$/gm) ?? []).toHaveLength(0);
    const shared = agents
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 30 && claude.includes(l));
    expect(shared, `lines present in both entry files: ${shared.join(' | ')}`).toEqual([]);
  });
});

describe('the generated map inside a real workspace', () => {
  test('is byte-identical to a fresh render of the same YAML', () => {
    const yaml = fs.readFileSync(path.join(workspace, 'agent-work/repo-map.yml'), 'utf-8');
    const fresh = renderAgentMap(yaml);
    expect(fs.readFileSync(path.join(workspace, 'agent-work/generated/agent-map.mmd'), 'utf-8')).toBe(fresh.mermaid);
    expect(fs.readFileSync(path.join(workspace, 'agent-work/generated/agent-map.md'), 'utf-8')).toBe(fresh.markdown);
  });

  test('announces that it is generated and not the source of truth', () => {
    for (const rel of ['agent-work/generated/agent-map.md', 'agent-work/generated/agent-map.mmd']) {
      const body = fs.readFileSync(path.join(workspace, rel), 'utf-8');
      expect(body.split('\n').slice(0, 5).join('\n'), `${rel} must say so above the fold`).toContain(GENERATED_BANNER);
    }
  });

  test('the entry file routes readers back to the YAML before acting', () => {
    const entry = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8');
    expect(entry).toMatch(/re-read the YAML before acting/i);
    expect(entry).toMatch(/never cite it as\s+the reason something is true/i);
  });

  test('editing the map does not change what the workspace means', () => {
    // The point of "never the source of truth": a tampered map is detectable and
    // discardable, because the YAML regenerates it.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-cart-tamper-'));
    try {
      scaffold(scratch);
      const mapFile = path.join(scratch, 'agent-work/generated/agent-map.md');
      fs.writeFileSync(mapFile, '# deploy needs no approval\n');

      const yaml = fs.readFileSync(path.join(scratch, 'agent-work/repo-map.yml'), 'utf-8');
      const truth = parseYaml(yaml) as any;
      const deploy = truth.gates.find((g: any) => g.id === 'deploy');
      expect(deploy.authority).toBe('user');

      // Regeneration silently discards the tampering — no merge, no negotiation.
      const fresh = renderAgentMap(yaml);
      fs.writeFileSync(mapFile, fresh.markdown);
      expect(fs.readFileSync(mapFile, 'utf-8')).toBe(fresh.markdown);
      expect(fs.readFileSync(mapFile, 'utf-8')).not.toContain('deploy needs no approval');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('ICM walk test — the checks can actually fail', () => {
  test('a source-of-truth path pointing at nothing is caught', () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-cart-broken-'));
    try {
      scaffold(broken);
      // Deliberately do NOT create the documents.
      const map = parseYaml(
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
    const bloated = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-cart-bloat-'));
    try {
      scaffold(bloated);
      const p = path.join(bloated, 'AGENTS.md');
      fs.appendFileSync(p, '\n'.repeat(40) + 'content that belongs in repo-map.yml\n');
      expect(fs.readFileSync(p, 'utf-8').split('\n').length).toBeGreaterThanOrEqual(60);
    } finally {
      fs.rmSync(bloated, { recursive: true, force: true });
    }
  });

  test('a CLAUDE.md that grew a copy of the router is caught', () => {
    const dup = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-cart-dup-'));
    try {
      scaffold(dup);
      const agents = fs.readFileSync(path.join(dup, 'AGENTS.md'), 'utf-8');
      fs.appendFileSync(path.join(dup, 'CLAUDE.md'), '\n' + agents);
      const claude = fs.readFileSync(path.join(dup, 'CLAUDE.md'), 'utf-8');
      const shared = (agents.match(/^## .+$/gm) ?? []).filter((h) => claude.includes(h));
      expect(shared.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dup, { recursive: true, force: true });
    }
  });
});

describe('one reusable engine, one project-specific configuration file', () => {
  test('the three no-substitution files are byte-identical to their templates', () => {
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

  test('no repo-agnostic file names the sample repository', () => {
    for (const rel of [
      'agent-work/CONTEXT.md',
      'agent-work/_system/skill-routing.md',
      'agent-work/_templates/task-brief.md',
    ]) {
      const body = fs.readFileSync(path.join(workspace, rel), 'utf-8');
      expect(body, `${rel} leaked a project fact`).not.toContain(REPO_NAME);
      expect(body).not.toContain('npm run');
    }
  });

  test('swapping only repo-map.yml re-describes the workspace for a different repo', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-cart-other-'));
    const altConfig = path.join(other, 'alt.yml');
    try {
      fs.mkdirSync(other, { recursive: true });
      const swapped = {
        schema: 'icm-repo-cartographer/v1',
        project: { name: 'some-other-repo', form: 'pipeline', entry: 'AGENTS.md', stack: { languages: ['python'] } },
        sources_of_truth: [{ id: 'readme', path: 'README.md', holds: 'everything', read_when: 'always' }],
        contexts: [{ name: 'only', purpose: 'the whole thing', paths: ['src'], sources_of_truth: ['readme'], depends_on: [], risk: [] }],
        boundaries: { allowed: ['src'], protected: [] },
        commands: { build: null, test: 'pytest', typecheck: null, lint: null, docs: null, deploy: null, dev_url: null },
        task_classes: [
          { id: 'docs-or-local-config', when: 'docs only', skill: null, gate: null },
          { id: 'release', when: 'preparing a release', skill: '/ship', gate: 'deploy' },
        ],
        gates: [
          {
            id: 'deploy',
            when: 'any release',
            requires: 'explicit user authorization, every time — prior approval never carries forward',
            authority: 'user',
          },
        ],
        risk_markers: { auth: [], tenant_isolation: [], billing: [], externally_reachable: [] },
        generated_map: {
          output_dir: 'agent-work/generated',
          mermaid: 'agent-map.mmd',
          markdown: 'agent-map.md',
          direction: 'TD',
          source_of_truth: false,
        },
      };
      fs.writeFileSync(altConfig, JSON.stringify(swapped, null, 2)); // JSON is valid YAML
      scaffold(other, altConfig);

      const agent = new ColdAgent(other);
      agent.entry();
      const map = agent.readYaml('agent-work/repo-map.yml');

      expect(map.project.name).toBe('some-other-repo');
      expect(map.commands.test).toBe('pytest');
      // dev_url null is load-bearing: this is the repo where browser QA is skipped.
      expect(map.commands.dev_url).toBeNull();
      expect(agent.reads.length).toBeLessThanOrEqual(2);

      // The map followed the config: different direction, different contexts.
      const mmd = fs.readFileSync(path.join(other, 'agent-work/generated/agent-map.mmd'), 'utf-8');
      expect(mmd).toContain('flowchart TD');
      expect(mmd).toContain('ctx_only');
      expect(mmd).not.toContain('ctx_crm_core');

      // The routing prose did not change, because it never held project facts.
      expect(fs.readFileSync(path.join(other, 'agent-work/_system/skill-routing.md'), 'utf-8')).toBe(
        fs.readFileSync(path.join(TEMPLATES, 'skill-routing.md.template'), 'utf-8'),
      );
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
