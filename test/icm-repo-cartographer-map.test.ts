/**
 * Agent-map generator (free, hermetic).
 *
 * The map is a VIEW of `agent-work/repo-map.yml`, never the source of truth, and
 * three properties have to hold for that claim to mean anything:
 *
 *   1. Reproducible — identical YAML in, byte-identical map out. Without this,
 *      `--check` cannot tell drift from noise and the whole generated/ directory
 *      becomes something people stop trusting and start ignoring.
 *   2. Self-describing — the output says, in its own first lines, that it is
 *      generated and not authoritative. A reader who opens the map alone must not
 *      be able to mistake it for the config.
 *   3. Fail-loud — an invalid config names the field, what was found, and the edit
 *      that fixes it. A validator that says "invalid input" teaches nobody
 *      anything and gets worked around.
 *
 * The Mermaid is checked structurally: balanced subgraphs, identifier-safe node
 * ids, no forward references out of their subgraph, labels that cannot break the
 * quoting. It is NOT run through a Mermaid renderer — that needs a browser, which
 * this skill deliberately does not depend on.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseRepoMap,
  renderMermaid,
  renderMarkdown,
  renderAgentMap,
  RepoMapError,
  REPO_MAP_SCHEMA,
  RISK_MARKER_KEYS,
  GENERATED_BANNER,
} from '../lib/agent-map';

const ROOT = path.join(import.meta.dir, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'icm-repo-cartographer', 'sample-repo-map.yml');
const YAML = fs.readFileSync(FIXTURE, 'utf-8');

/** Re-serialize a parsed fixture with one field changed, so negative cases stay readable. */
function mutate(edit: (doc: Record<string, any>) => void): string {
  const doc = Bun.YAML.parse(YAML) as Record<string, any>;
  edit(doc);
  return JSON.stringify(doc, null, 2); // JSON is valid YAML
}

function expectError(yaml: string, field: string, ...phrases: string[]): RepoMapError {
  let thrown: unknown;
  try {
    parseRepoMap(yaml);
  } catch (err) {
    thrown = err;
  }
  expect(thrown, `expected ${field} to fail validation`).toBeInstanceOf(RepoMapError);
  const err = thrown as RepoMapError;
  expect(err.field).toBe(field);
  for (const phrase of phrases) {
    expect(err.message.toLowerCase()).toContain(phrase.toLowerCase());
  }
  return err;
}

describe('the sample repo-map parses', () => {
  const map = parseRepoMap(YAML);

  test('schema, identity and stack survive the round trip', () => {
    expect(map.schema).toBe(REPO_MAP_SCHEMA);
    expect(map.project.name).toBe('sample-crm');
    expect(map.project.form).toBe('composed');
    expect(map.project.entry).toBe('AGENTS.md');
    expect(map.project.stack.languages).toEqual(['typescript', 'sql']);
  });

  test('every context resolves its documents and dependencies', () => {
    const ids = new Set(map.sources_of_truth.map((s) => s.id));
    const names = new Set(map.contexts.map((c) => c.name));
    for (const ctx of map.contexts) {
      for (const id of ctx.sources_of_truth) expect(ids).toContain(id);
      for (const dep of ctx.depends_on) expect(names).toContain(dep);
      for (const marker of ctx.risk) expect(RISK_MARKER_KEYS).toContain(marker as never);
    }
  });

  test('the deploy gate is mandatory, user-authorized, and not self-clearable', () => {
    const deploy = map.gates.find((g) => g.id === 'deploy')!;
    expect(deploy.authority).toBe('user');
    expect(deploy.self_clearable).toBe(false);
    expect(deploy.requires).toMatch(/never carries forward/i);
  });

  test('the routing table keeps a no-workflow class', () => {
    expect(map.task_classes.some((tc) => tc.skill === null)).toBe(true);
    const byId = Object.fromEntries(map.task_classes.map((tc) => [tc.id, tc]));
    expect(byId['cross-context-feature'].skill).toBe('/autoplan');
    expect(byId['bug-or-failure'].skill).toBe('/investigate');
    expect(byId['pr-ready-implementation'].skill).toBe('/review');
    expect(byId['browser-visible'].skill).toBe('/qa');
    expect(byId['security-sensitive'].skill).toBe('/cso');
    expect(byId['release'].skill).toBe('/ship');
    expect(byId['release'].gate).toBe('deploy');
  });

  test('the config asserts that its own rendered map is not authoritative', () => {
    expect(map.generated_map.source_of_truth).toBe(false);
  });
});

describe('the map is reproducible', () => {
  test('identical YAML produces byte-identical output', () => {
    const a = renderAgentMap(YAML);
    const b = renderAgentMap(YAML);
    expect(a.mermaid).toBe(b.mermaid);
    expect(a.markdown).toBe(b.markdown);
  });

  test('output carries no clock, no random, no absolute path', () => {
    const { mermaid, markdown } = renderAgentMap(YAML);
    const both = mermaid + markdown;
    // A timestamp is the classic way a "reproducible" generator stops being one.
    expect(both).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(both).not.toMatch(/[A-Za-z]:\\Users\\/);
    expect(both).not.toContain(ROOT);
  });

  test('a changed field changes the output — the renderer actually reads the config', () => {
    const changed = mutate((doc) => {
      doc.contexts[0].purpose = 'something else entirely';
    });
    expect(renderAgentMap(changed).mermaid).not.toBe(renderAgentMap(YAML).mermaid);
  });
});

describe('the map never becomes the source of truth', () => {
  const { mermaid, markdown } = renderAgentMap(YAML);

  test('the Mermaid source leads with the generated banner', () => {
    expect(mermaid.split('\n')[0]).toBe(`%% ${GENERATED_BANNER}`);
  });

  test('the readable map says so above the fold, in its first five lines', () => {
    const head = markdown.split('\n').slice(0, 5).join('\n');
    expect(head).toContain(GENERATED_BANNER);
  });

  test('the readable map names the canonical file and says which wins on disagreement', () => {
    expect(markdown).toContain('agent-work/repo-map.yml');
    expect(markdown).toMatch(/the YAML wins and this page is stale/i);
    expect(markdown).toMatch(/regenerate it rather than editing it/i);
  });
});

describe('the rendered Mermaid is structurally sound', () => {
  const mermaid = renderMermaid(parseRepoMap(YAML));
  const lines = mermaid.split('\n').filter((l) => l.trim() !== '');

  test('declares a flowchart with the configured direction', () => {
    expect(lines.find((l) => l.startsWith('flowchart '))).toBe('flowchart LR');
  });

  test('subgraphs are balanced', () => {
    const opens = lines.filter((l) => l.trim().startsWith('subgraph ')).length;
    const ends = lines.filter((l) => l.trim() === 'end').length;
    expect(opens).toBeGreaterThan(0);
    expect(ends).toBe(opens);
  });

  test('every node id is identifier-safe', () => {
    const declared = lines
      .map((l) => l.match(/^\s{4}([A-Za-z0-9_]+)[[{>(]/)?.[1])
      .filter((x): x is string => Boolean(x));
    expect(declared.length).toBeGreaterThan(0);
    for (const id of declared) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
  });

  test('no edge references a node before its subgraph declares it', () => {
    // Mermaid places a node where it is FIRST mentioned. An edge written before
    // the subgraph would silently drag the node out of its group.
    const declared = new Set<string>(['START']);
    const dangling: string[] = [];
    for (const line of lines) {
      const decl = line.match(/^\s{4}([A-Za-z0-9_]+)[[{>(]/);
      if (decl) {
        declared.add(decl[1]);
        continue;
      }
      const edge = line.match(/^\s{2}([A-Za-z0-9_]+)\s+\S*[-=.>]+\S*\s+([A-Za-z0-9_]+)\s*$/);
      if (edge) {
        for (const node of [edge[1], edge[2]]) if (!declared.has(node)) dangling.push(`${node} (${line.trim()})`);
      }
    }
    expect(dangling, `nodes referenced before declaration: ${dangling.join(', ')}`).toEqual([]);
  });

  test('labels cannot break the quoting', () => {
    for (const line of lines) {
      const quoted = line.match(/"([^"]*)"/g) ?? [];
      for (const q of quoted) expect(q.slice(1, -1)).not.toContain('"');
    }
  });

  test('renders contexts, their edges, documents, boundaries, routing and gates', () => {
    expect(mermaid).toContain('subgraph CONTEXTS');
    expect(mermaid).toContain('subgraph DOCS');
    expect(mermaid).toContain('subgraph GATES');
    expect(mermaid).toContain('subgraph PROTECTED');
    expect(mermaid).toContain('subgraph ROUTING');
    expect(mermaid).toContain('ctx_communications --> ctx_crm_core');
    expect(mermaid).toContain('ctx_tenants -.reads.-> sot_tenancy');
    expect(mermaid).toContain('prot_0 ==> gate_migration');
    expect(mermaid).toContain('tc_release ==> gate_deploy');
  });

  test('a no-workflow class is drawn as such, not as a skill', () => {
    expect(mermaid).toContain('no mandatory workflow');
  });
});

describe('the readable map carries the tables a human needs', () => {
  const markdown = renderMarkdown(parseRepoMap(YAML), renderMermaid(parseRepoMap(YAML)));

  test('embeds the Mermaid in a fenced block', () => {
    expect(markdown).toContain('```mermaid');
  });

  test('lists contexts, documents, protected boundaries, routing, gates and commands', () => {
    for (const heading of [
      '## Bounded contexts',
      '## Source of truth',
      '## Protected boundaries',
      '## Task routing',
      '## Human gates',
      '## Commands',
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain('`npm run typecheck`');
    expect(markdown).toMatch(/Never run every skill on every task/i);
  });

  test('a null command reads as unset rather than as an empty cell', () => {
    const withNull = mutate((doc) => {
      doc.commands.docs = null;
    });
    const md = renderAgentMap(withNull).markdown;
    expect(md).toContain('| `docs` | _not set_ |');
  });
});

describe('invalid configuration fails with an actionable error', () => {
  test('a wrong schema pin names the expected value', () => {
    expectError(mutate((d) => (d.schema = 'something/else')), 'schema', REPO_MAP_SCHEMA, 'migrate');
  });

  test('an unknown project form lists the valid ones', () => {
    expectError(mutate((d) => (d.project.form = 'lasagna')), 'project.form', 'context-map', 'pipeline', 'composed');
  });

  test('a project summary is rejected with the reason, not just a rule', () => {
    expectError(
      mutate((d) => (d.project.summary = 'a CRM')),
      'project.summary',
      'AGENTS.md',
      'first fact to drift',
    );
  });

  test('a context pointing at an unknown document lists the known ids', () => {
    const err = expectError(
      mutate((d) => d.contexts[0].sources_of_truth.push('no-such-doc')),
      'contexts[crm-core].sources_of_truth',
      'no-such-doc',
      'known ids',
    );
    expect(err.message).toContain('terminology');
  });

  test('a context depending on an unknown context lists the known names', () => {
    expectError(
      mutate((d) => d.contexts[0].depends_on.push('ghost')),
      'contexts[crm-core].depends_on',
      'ghost',
      'known contexts',
    );
  });

  test('a self-dependency is caught', () => {
    expectError(
      mutate((d) => d.contexts[0].depends_on.push('crm-core')),
      'contexts[crm-core].depends_on',
      'cannot depend on itself',
    );
  });

  test('an unknown risk marker lists the fixed four', () => {
    expectError(mutate((d) => d.contexts[0].risk.push('vibes')), 'contexts[crm-core].risk', 'vibes', 'auth');
  });

  test('an extra risk_markers key is rejected — the set is fixed on purpose', () => {
    expectError(mutate((d) => (d.risk_markers.vibes = [])), 'risk_markers', 'fixed on purpose', 'empty list');
  });

  test('a protected boundary pointing at an unknown gate lists the known gates', () => {
    expectError(
      mutate((d) => (d.boundaries.protected[0].gate = 'nope')),
      'boundaries.protected[0].gate',
      'nope',
      'known gates',
    );
  });

  test('a self-clearable deploy gate is refused', () => {
    expectError(
      mutate((d) => (d.gates.find((g: any) => g.id === 'deploy').self_clearable = true)),
      'gates[deploy].self_clearable',
      'never clears its own',
    );
  });

  test('a deploy gate whose authority is not the user is refused', () => {
    expectError(
      mutate((d) => (d.gates.find((g: any) => g.id === 'deploy').authority = 'ci')),
      'gates[deploy].authority',
      'explicit user authorization',
    );
  });

  test('a routing table where everything earns a workflow is refused', () => {
    expectError(
      mutate((d) => {
        for (const tc of d.task_classes) if (tc.skill === null) tc.skill = '/review';
      }),
      'task_classes',
      'ceremony, not routing',
    );
  });

  test('a skill that is not a slash command says what the value should look like', () => {
    expectError(mutate((d) => (d.task_classes[1].skill = 'autoplan')), 'task_classes[1].skill', '/review', 'null');
  });

  test('claiming the generated map is the source of truth is refused', () => {
    expectError(
      mutate((d) => (d.generated_map.source_of_truth = true)),
      'generated_map.source_of_truth',
      'must be false',
      'this file wins',
    );
  });

  test('malformed YAML is reported as a syntax problem, not a schema one', () => {
    expectError('project: [unclosed\n  - x', '(whole file)', 'not valid yaml');
  });

  test('every error message names the file and a next action', () => {
    const err = expectError(mutate((d) => (d.schema = 'x')), 'schema');
    expect(err.message.startsWith('repo-map.yml: ')).toBe(true);
    expect(err.message.length).toBeGreaterThan(40);
  });
});

describe('the gstack-agent-map CLI', () => {
  const CLI = path.join(ROOT, 'bin', 'gstack-agent-map.ts');

  function run(args: string[], cwd: string) {
    const proc = Bun.spawnSync(['bun', 'run', CLI, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    return {
      code: proc.exitCode,
      out: new TextDecoder().decode(proc.stdout),
      err: new TextDecoder().decode(proc.stderr),
    };
  }

  function workspaceWith(yaml: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-cli-'));
    fs.mkdirSync(path.join(dir, 'agent-work'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent-work', 'repo-map.yml'), yaml);
    return dir;
  }

  test('writes both files and exits 0', () => {
    const dir = workspaceWith(YAML);
    try {
      const r = run([], dir);
      expect(r.code).toBe(0);
      expect(r.out).toContain('agent-map.mmd');
      expect(r.out).toContain('agent-map.md');
      const expected = renderAgentMap(YAML);
      expect(fs.readFileSync(path.join(dir, 'agent-work/generated/agent-map.mmd'), 'utf-8')).toBe(expected.mermaid);
      expect(fs.readFileSync(path.join(dir, 'agent-work/generated/agent-map.md'), 'utf-8')).toBe(expected.markdown);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--check passes on a freshly generated map and fails once the YAML moves on', () => {
    const dir = workspaceWith(YAML);
    try {
      expect(run([], dir).code).toBe(0);
      expect(run(['--check'], dir).code).toBe(0);

      // Change the config without regenerating: the map is now stale, by definition.
      fs.writeFileSync(
        path.join(dir, 'agent-work/repo-map.yml'),
        mutate((d) => (d.contexts[0].purpose = 'moved on')),
      );
      const stale = run(['--check'], dir);
      expect(stale.code).toBe(1);
      expect(stale.err).toContain('stale');
      expect(stale.err).toContain('Regenerate');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an invalid config exits 2 and prints the field, the problem and the file', () => {
    const dir = workspaceWith(mutate((d) => (d.generated_map.source_of_truth = true)));
    try {
      const r = run([], dir);
      expect(r.code).toBe(2);
      expect(r.err).toContain('invalid config');
      expect(r.err).toContain('generated_map.source_of_truth');
      expect(r.err).toContain('must be false');
      expect(r.err).toContain('repo-map.yml');
      // ...and it wrote nothing.
      expect(fs.existsSync(path.join(dir, 'agent-work/generated'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing config exits 1 and says how to create one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-cli-empty-'));
    try {
      const r = run([], dir);
      expect(r.code).toBe(1);
      expect(r.err).toContain('no config at');
      expect(r.err).toContain('/icm-repo-cartographer');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--stdout prints the Mermaid and writes nothing', () => {
    const dir = workspaceWith(YAML);
    try {
      const r = run(['--stdout'], dir);
      expect(r.code).toBe(0);
      expect(r.out).toBe(renderAgentMap(YAML).mermaid);
      expect(fs.existsSync(path.join(dir, 'agent-work/generated'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
