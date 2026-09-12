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
import { parse as parseYaml } from 'yaml';
import { runAgentMapCli } from './helpers/run-agent-map-cli';
import {
  parseRepoMap,
  renderMermaid,
  renderMarkdown,
  renderAgentMap,
  RepoMapError,
  REPO_MAP_SCHEMA,
  RISK_MARKER_KEYS,
  GENERATED_BANNER,
  GENERATED_DIR,
  GENERATED_MERMAID,
  GENERATED_MARKDOWN,
} from '../lib/agent-map';

const ROOT = path.join(import.meta.dir, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'icm-repo-cartographer', 'sample-repo-map.yml');
const YAML = fs.readFileSync(FIXTURE, 'utf-8');

/** Re-serialize a parsed fixture with one field changed, so negative cases stay readable. */
function mutate(edit: (doc: Record<string, any>) => void): string {
  const doc = parseYaml(YAML) as Record<string, any>;
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

  test('the deploy gate is mandatory and user-authorized', () => {
    const deploy = map.gates.find((g) => g.id === 'deploy')!;
    expect(deploy.authority).toBe('user');
    expect(deploy.requires).toMatch(/never carries forward/i);
  });

  test('no gate carries a self-clearable flag — the concept does not exist', () => {
    for (const gate of map.gates) {
      expect(Object.keys(gate).sort()).toEqual(['authority', 'id', 'requires', 'when']);
    }
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

  test('declaring self_clearable at all is refused, on any gate', () => {
    // The old design let a non-deploy gate declare itself self-clearable; only
    // deploy was checked. The field is gone rather than constrained, so there is
    // nothing left to get wrong.
    expectError(
      mutate((d) => (d.gates.find((g: any) => g.id === 'deploy').self_clearable = false)),
      'gates[0].self_clearable',
      'remove it',
      'every gate is non-self-clearable',
    );
    const err = expectError(
      mutate((d) => (d.gates.find((g: any) => g.id === 'migration').self_clearable = true)),
      'gates[1].self_clearable',
      'remove it',
    );
    // The message has to teach the distinction, or the author just deletes the
    // gate and loses the approval boundary.
    expect(err.message).toMatch(/it is a check rather than a gate/i);
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

  // Routed through the shared runner so the sync spawn carries a finite timeout
  // in one place: a child that blocks forever wedges the whole shard, because
  // bun's per-test timeout cannot fire while a synchronous spawn is waiting.
  const run = (args: string[], cwd: string) => runAgentMapCli(CLI, args, cwd);

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

// ─── Codex review 5184164055 regressions ─────────────────────────────────────

describe('P1 — the engine runs across the declared Bun range', () => {
  const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

  test('the shipped fixture parses and renders without Bun.YAML', () => {
    // Bun.YAML does not exist in Bun 1.2.14, which satisfies `bun >=1.0.0`, so
    // every render threw there — including on this fixture. The parser now comes
    // from a package that runs anywhere in the range.
    const map = parseRepoMap(YAML);
    expect(map.project.name).toBe('sample-crm');
    const { mermaid, markdown } = renderAgentMap(YAML);
    expect(mermaid).toContain('flowchart LR');
    expect(markdown).toContain('## Bounded contexts');
  });

  test('no runtime or test file in this skill reaches for Bun.YAML', () => {
    const owned = [
      'lib/agent-map.ts',
      'bin/gstack-agent-map.ts',
      'test/icm-repo-cartographer-map.test.ts',
      'test/icm-repo-cartographer-scaffold.test.ts',
      'test/icm-repo-cartographer-walk-test.test.ts',
    ];
    for (const rel of owned) {
      const body = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      // The name may appear in a comment explaining why it is gone; a CALL may not.
      expect(body, `${rel} still calls Bun.YAML`).not.toMatch(/Bun\.YAML\s*\./);
    }
  });

  test('yaml is a direct dependency and the engine floor is unchanged', () => {
    expect(PKG.dependencies.yaml).toBeTruthy();
    // The support promise is preserved rather than raised out from under users.
    expect(PKG.engines.bun).toBe('>=1.0.0');
  });
});

describe('P2 — duplicate gate ids are rejected before the deploy checks', () => {
  test('a second deploy gate fails, naming both indices', () => {
    const err = expectError(
      mutate((d) =>
        d.gates.push({
          id: 'deploy',
          when: 'a sneaky second definition',
          requires: 'nothing at all',
          authority: 'agent',
        }),
      ),
      'gates[2].id',
      'duplicate gate id',
      'gates[0]',
    );
    expect(err.message).toMatch(/rename one, or merge them/i);
  });

  test('the duplicate is caught even when the second entry would pass on its own', () => {
    // The danger is silent acceptance, not a malformed entry: a well-formed second
    // `deploy` previously slipped past find() and could contradict the first.
    expectError(
      mutate((d) =>
        d.gates.push({
          id: 'deploy',
          when: 'identical shape, different authority',
          requires: 'explicit user authorization, every time — prior approval never carries forward',
          authority: 'agent',
        }),
      ),
      'gates[2].id',
      'duplicate gate id',
    );
  });

  test('duplicate context names are rejected for the same reason', () => {
    const err = expectError(
      mutate((d) => d.contexts.push({ ...d.contexts[0] })),
      'contexts[4].name',
      'duplicate context name',
      'contexts[0]',
    );
    expect(err.message).toMatch(/depends_on resolves a context by name/i);
  });

  test('rejection happens during parse, so nothing is ever rendered', () => {
    const bad = mutate((d) =>
      d.gates.push({ id: 'deploy', when: 'x', requires: 'y', authority: 'agent' }),
    );
    expect(() => renderAgentMap(bad)).toThrow(RepoMapError);
  });
});

describe('P2 — Mermaid node ids stay unique when names collide after slugging', () => {
  /** Two contexts whose names differ only in punctuation, plus two non-ASCII names. */
  const colliding = () =>
    mutate((d) => {
      d.contexts = [
        { name: 'billing-api', purpose: 'hyphenated', paths: ['src/a'], sources_of_truth: [], depends_on: [], risk: [] },
        { name: 'billing api', purpose: 'spaced', paths: ['src/b'], sources_of_truth: [], depends_on: ['billing-api'], risk: [] },
        { name: '決済', purpose: 'non-ascii one', paths: ['src/c'], sources_of_truth: [], depends_on: [], risk: [] },
        { name: '課金', purpose: 'non-ascii two', paths: ['src/d'], sources_of_truth: [], depends_on: ['決済'], risk: [] },
      ];
      d.boundaries.protected = [];
    });

  test('punctuation variants get distinct nodes rather than merging', () => {
    const mermaid = renderAgentMap(colliding()).mermaid;
    const declared = (mermaid.match(/^\s{4}(ctx_[A-Za-z0-9_]+)\[/gm) ?? []).map((l) => l.trim().split('[')[0]);
    expect(declared).toHaveLength(4);
    expect(new Set(declared).size, `ids collided: ${declared.join(', ')}`).toBe(4);
    expect(declared).toContain('ctx_billing_api');
    expect(declared).toContain('ctx_billing_api_2');
  });

  test('non-ASCII names that both fall back to the same slug stay distinct', () => {
    const mermaid = renderAgentMap(colliding()).mermaid;
    expect(mermaid).toContain('ctx_x[');
    expect(mermaid).toContain('ctx_x_2[');
    // ...and the labels are still the real names, so the map still reads correctly.
    expect(mermaid).toContain('決済');
    expect(mermaid).toContain('課金');
  });

  test('edges point at the node the name actually belongs to', () => {
    const mermaid = renderAgentMap(colliding()).mermaid;
    // 'billing api' (allocated second, so _2) depends on 'billing-api' (first).
    expect(mermaid).toContain('ctx_billing_api_2 --> ctx_billing_api');
    // '課金' (x_2) depends on '決済' (x).
    expect(mermaid).toContain('ctx_x_2 --> ctx_x');
  });

  test('collision-suffixed output is still byte-reproducible', () => {
    const yaml = colliding();
    expect(renderAgentMap(yaml).mermaid).toBe(renderAgentMap(yaml).mermaid);
    expect(renderAgentMap(yaml).markdown).toBe(renderAgentMap(yaml).markdown);
  });

  test('a suffix is only added on a real collision', () => {
    // The ordinary fixture must not grow suffixes: this guards against a fix that
    // makes every id ugly in order to solve a rare case.
    const mermaid = renderAgentMap(YAML).mermaid;
    expect(mermaid).toContain('ctx_crm_core[');
    expect(mermaid).not.toMatch(/ctx_[a-z_]+_2\[/);
  });
});

describe('P2 — generated Markdown tables survive table-sensitive content', () => {
  /** Split a row on pipes that are NOT backslash-escaped — what a renderer does. */
  const cells = (row: string): string[] =>
    row
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/);

  const hostile = () =>
    mutate((d) => {
      d.commands = {
        build: 'npm run build | tee build.log',
        test: 'npm test `--reporter=dot`',
        typecheck: 'tsc --noEmit\nsecond line',
        lint: null,
        docs: 'a | b | c `x` | d',
        deploy: '`leading and trailing backtick`',
        dev_url: null,
      };
    });

  const commandRows = (markdown: string): string[] => {
    const section = markdown.split('## Commands')[1] ?? '';
    return section.split('\n').filter((l) => l.startsWith('|') && !l.startsWith('|---'));
  };

  test('a shell pipeline does not grow the row an extra column', () => {
    const rows = commandRows(renderAgentMap(hostile()).markdown);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(cells(row), `row split into the wrong number of cells: ${row}`).toHaveLength(2);
    }
  });

  test('every literal pipe survives as an escaped pipe, not a delimiter', () => {
    const markdown = renderAgentMap(hostile()).markdown;
    expect(markdown).toContain('npm run build \\| tee build.log');
    expect(markdown).toContain('a \\| b \\| c');
  });

  test('an embedded newline cannot end the row', () => {
    const markdown = renderAgentMap(hostile()).markdown;
    const typecheckRow = commandRows(markdown).find((r) => r.includes('tsc --noEmit'))!;
    expect(typecheckRow).toContain('tsc --noEmit<br/>second line');
    expect(typecheckRow.split('\n')).toHaveLength(1);
  });

  test('backticks inside a value cannot terminate the code span', () => {
    const markdown = renderAgentMap(hostile()).markdown;
    const testRow = commandRows(markdown).find((r) => r.includes('npm test'))!;
    // The fence is one backtick longer than the longest run inside the value, and
    // the value ends with a backtick so CommonMark's padding space applies on both
    // sides of the span.
    expect(testRow).toContain('`` npm test `--reporter=dot` ``');
    const deployRow = commandRows(markdown).find((r) => r.includes('leading and trailing'))!;
    // Leading/trailing backticks get the CommonMark padding space.
    expect(deployRow).toContain('`` `leading and trailing backtick` ``');
  });

  test('ordinary commands still render as plain code spans', () => {
    const markdown = renderAgentMap(YAML).markdown;
    expect(markdown).toContain('| `test` | `npm run test` |');
    expect(markdown).toContain('| `typecheck` | `npm run typecheck` |');
    expect(markdown).toContain('| `lint` | `npm run lint` |');
  });

  test('the other tables are escaped too — same defect, same fix', () => {
    const md = renderAgentMap(
      mutate((d) => {
        d.contexts[0].purpose = 'customers | jobs';
        d.sources_of_truth[0].holds = 'terms | layers';
        d.task_classes[0].when = 'docs | config';
      }),
    ).markdown;
    expect(md).toContain('customers \\| jobs');
    expect(md).toContain('terms \\| layers');
    expect(md).toContain('docs \\| config');
    for (const row of md.split('\n').filter((l) => l.startsWith('| **crm-core**'))) {
      expect(cells(row)).toHaveLength(4);
    }
  });
});

describe('the CLI refuses a duplicate deploy gate before writing anything', () => {
  const CLI = path.join(ROOT, 'bin', 'gstack-agent-map.ts');

  test('exit 2, the field named, and no generated/ directory left behind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-cli-dupgate-'));
    try {
      fs.mkdirSync(path.join(dir, 'agent-work'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'agent-work', 'repo-map.yml'),
        mutate((d) =>
          d.gates.push({
            id: 'deploy',
            when: 'a second definition that would otherwise pass',
            requires: 'explicit user authorization, every time — prior approval never carries forward',
            authority: 'agent',
          }),
        ),
      );

      const proc = runAgentMapCli(CLI, [], dir);
      const err = proc.err;

      expect(proc.code).toBe(2);
      expect(err).toContain('invalid config');
      expect(err).toContain('gates[2].id');
      expect(err).toContain('duplicate gate id');
      // The point of "before output is written": a conflicting deployment
      // instruction must never reach a generated file at all.
      expect(fs.existsSync(path.join(dir, 'agent-work/generated'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the schema cannot choose where output goes, or what it is called', () => {
  // The design correction: output location and artifact names are not project
  // facts. They were configurable once and that produced two separate findings —
  // `output_dir: ../victim` overwriting files outside the repository, and
  // filesystem-alias collisions between configurable filenames. Rather than adding
  // more path and normalisation logic, the fields are gone. Invalid states are
  // unrepresentable instead of validated.
  const retired: Array<[string, unknown]> = [
    ['output_dir', '../victim'],
    ['mermaid', 'evil.mmd'],
    ['markdown', 'evil.md'],
  ];

  test.each(retired)('generated_map.%s is refused as a retired field', (field, value) => {
    const err = expectError(
      mutate((d) => (d.generated_map[field as string] = value)),
      `generated_map.${field}`,
      'remove it',
      'fixed tool policy',
    );
    // The message must explain, not just refuse: an author who wanted this needs
    // to know where the artifacts go now and what the supported override is.
    expect(err.message).toMatch(/agent-map\.(mmd|md)|agent-work\/generated/);
  });

  test('the retired output_dir explains the override and the danger', () => {
    const err = expectError(
      mutate((d) => (d.generated_map.output_dir = '../victim')),
      'generated_map.output_dir',
      'remove it',
    );
    expect(err.message).toContain('--out <dir>');
    expect(err.message).toMatch(/overwrite files\s+outside the repository/i);
  });

  test('generated_map keeps only the two project-relevant fields', () => {
    const map = parseRepoMap(YAML);
    expect(Object.keys(map.generated_map).sort()).toEqual(['direction', 'source_of_truth']);
    expect(map.generated_map.source_of_truth).toBe(false);
  });

  test('the fixed policy is exported once, so nothing can drift from it', () => {
    expect(GENERATED_DIR).toBe('agent-work/generated');
    expect(GENERATED_MERMAID).toBe('agent-map.mmd');
    expect(GENERATED_MARKDOWN).toBe('agent-map.md');
  });
});

describe('unknown fields are rejected, never ignored', () => {
  // A silently ignored key is how a config lies: the author believes they
  // configured something, the parse succeeds, and the setting does nothing.
  const cases: Array<[string, (d: any) => void, string]> = [
    ['top level', (d) => (d.surprise = 1), 'surprise'],
    ['project', (d) => (d.project.owner = 'someone'), 'project.owner'],
    ['project.stack', (d) => (d.project.stack.editor = 'vim'), 'project.stack.editor'],
    ['a source of truth', (d) => (d.sources_of_truth[0].author = 'x'), 'sources_of_truth[0].author'],
    ['a context', (d) => (d.contexts[0].owner = 'x'), 'contexts[0].owner'],
    ['boundaries', (d) => (d.boundaries.forbidden = []), 'boundaries.forbidden'],
    ['a protected boundary', (d) => (d.boundaries.protected[0].severity = 'high'), 'boundaries.protected[0].severity'],
    ['commands', (d) => (d.commands.publish = 'npm publish'), 'commands.publish'],
    ['a task class', (d) => (d.task_classes[0].priority = 1), 'task_classes[0].priority'],
    ['a gate', (d) => (d.gates[0].sla = '1d'), 'gates[0].sla'],
    ['generated_map', (d) => (d.generated_map.colour = 'blue'), 'generated_map.colour'],
  ];

  test.each(cases)('an unknown key in %s fails, naming the field', (_where, edit, field) => {
    const err = expectError(mutate(edit), field, 'unknown field');
    expect(err.message).toMatch(/This schema accepts only:/);
    expect(err.message).toMatch(/silently does nothing is worse/i);
  });
});

