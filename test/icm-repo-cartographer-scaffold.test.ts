/**
 * /icm-repo-cartographer scaffold pins (free, static).
 *
 * The skill's whole value is that the adapter it leaves behind stays small and
 * stays honest. Four properties are load-bearing and all four are easy to erode
 * by a well-meaning edit:
 *
 *   1. AGENTS.md is a router, under 60 lines, carrying pointers and no content.
 *   2. CLAUDE.md is a pointer, never a second copy — two entry files that both
 *      carry content drift, and the day they disagree neither is trustworthy.
 *   3. repo-map.yml is the ONLY project-specific file. One reusable engine, one
 *      project-specific configuration file.
 *   4. The routing TABLE lives in the YAML; the prose explains how to apply it and
 *      does not restate it. Otherwise the policy has two homes.
 *
 * These assertions pin the templates so a refactor cannot quietly turn the router
 * into a document or spread project facts across the scaffold.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { parseRepoMap, RISK_MARKER_KEYS } from '../lib/agent-map';
import { parse as parseYaml } from 'yaml';

const ROOT = path.join(import.meta.dir, '..');
const SKILL = path.join(ROOT, 'icm-repo-cartographer');
const read = (p: string) => fs.readFileSync(path.join(SKILL, p), 'utf-8');
const lines = (s: string) => s.split('\n').length;

const SCAFFOLD_TEMPLATES = [
  'AGENTS.md.template',
  'CLAUDE.md.template',
  'CONTEXT.md.template',
  'repo-map.yml.template',
  'skill-routing.md.template',
  'task-brief.md.template',
];

describe('icm-repo-cartographer scaffold templates', () => {
  test('ships exactly the six authored starters — the other two files are generated', () => {
    const found = fs.readdirSync(path.join(SKILL, 'templates')).sort();
    expect(found).toEqual([...SCAFFOLD_TEMPLATES].sort());
  });

  test('AGENTS.md router stays under 60 lines', () => {
    // The ICM invariant: a small, stable entry file that routes and never holds
    // content. 60 is the ceiling, not the target.
    expect(lines(read('templates/AGENTS.md.template'))).toBeLessThan(60);
  });

  test('AGENTS.md points at all five workspace paths and restates none of them', () => {
    const agents = read('templates/AGENTS.md.template');
    for (const p of [
      'agent-work/repo-map.yml',
      'agent-work/CONTEXT.md',
      'agent-work/_system/skill-routing.md',
      'agent-work/_templates/task-brief.md',
      'agent-work/generated/agent-map.md',
    ]) {
      expect(agents).toContain(p);
    }
    expect(agents).toContain('sources_of_truth:');
    expect(agents).toMatch(/do not restate them here/i);
  });

  test('AGENTS.md carries the deploy gate, the route-by-risk rule, and the map caveat', () => {
    const agents = read('templates/AGENTS.md.template');
    expect(agents).toMatch(/Merging and deploying require explicit authorization from the user, every time/);
    expect(agents).toMatch(/never carries forward/i);
    expect(agents).toMatch(/Route by risk and scope, never by ceremony/i);
    expect(agents).toMatch(/the\s+YAML wins and the map is stale/i);
  });

  test('CLAUDE.md is a pointer, not a second router', () => {
    const claude = read('templates/CLAUDE.md.template');
    expect(claude).toContain('AGENTS.md');
    // Short by construction. A pointer that needs 30 lines is a document.
    expect(lines(claude)).toBeLessThan(20);
    expect(claude).not.toContain('## Where things live');
    expect(claude).not.toContain('## Route by what you were asked to do');
    expect(claude).not.toContain('agent-work/_system/skill-routing.md');
    expect(claude).toMatch(/one home per fact/i);
  });

  test('no routing content is duplicated between AGENTS.md and CLAUDE.md', () => {
    // Structural, not lexical: the pointer must not carry any of the router's
    // headings, table rows, or workspace paths beyond the one link.
    const agents = read('templates/AGENTS.md.template');
    const claude = read('templates/CLAUDE.md.template');

    const agentHeadings = agents.match(/^## .+$/gm) ?? [];
    expect(agentHeadings.length).toBeGreaterThan(0);
    for (const heading of agentHeadings) expect(claude).not.toContain(heading);

    expect(claude.match(/^\|.*\|$/gm) ?? []).toHaveLength(0);
    expect(claude).not.toContain('agent-work/');

    // And no long prose line appears in both.
    const shared = agents
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 30 && claude.includes(l));
    expect(shared, `lines present in both entry files: ${shared.join(' | ')}`).toEqual([]);
  });
});

describe('icm-repo-cartographer repo-map.yml is the only project-specific file', () => {
  const raw = read('templates/repo-map.yml.template');
  const parsed = parseYaml(raw) as Record<string, unknown>;

  test('the template itself is valid YAML (a config nobody can parse is a config nobody read)', () => {
    expect(parsed).toBeTruthy();
    expect(typeof parsed).toBe('object');
  });

  test('carries the schema pin and every required top-level key', () => {
    expect(parsed.schema).toBe('icm-repo-cartographer/v1');
    for (const key of [
      'project',
      'sources_of_truth',
      'contexts',
      'boundaries',
      'commands',
      'task_classes',
      'gates',
      'risk_markers',
      'generated_map',
    ]) {
      expect(Object.keys(parsed)).toContain(key);
    }
  });

  test('carries no project summary — that sentence has one home, the entry file', () => {
    const project = parsed.project as Record<string, unknown>;
    expect(Object.keys(project).sort()).toEqual(['entry', 'form', 'name', 'stack']);
    expect(raw).toMatch(/No summary here on purpose/i);
  });

  test('commands cover every intent the routing policy reads', () => {
    const commands = parsed.commands as Record<string, unknown>;
    expect(Object.keys(commands).sort()).toEqual(
      ['build', 'deploy', 'dev_url', 'docs', 'lint', 'test', 'typecheck'].sort(),
    );
    // dev_url null is load-bearing: browser QA skips explicitly, not accidentally.
    expect(commands.dev_url).toBeNull();
  });

  test('risk_markers is a fixed four-key set — an open set drifts into an unmaintained taxonomy', () => {
    const markers = parsed.risk_markers as Record<string, unknown>;
    expect(Object.keys(markers).sort()).toEqual([...RISK_MARKER_KEYS].sort());
  });

  test('the deploy gate ships mandatory, user-authorized and not self-clearable', () => {
    const gates = parsed.gates as Array<Record<string, unknown>>;
    const deploy = gates.find((g) => g.id === 'deploy');
    expect(deploy).toBeDefined();
    expect(deploy!.self_clearable).toBe(false);
    expect(deploy!.authority).toBe('user');
    expect(String(deploy!.requires)).toMatch(/explicit user authorization/i);
    expect(String(deploy!.requires)).toMatch(/never carries forward/i);
  });

  test('the shipped routing table matches the stated policy', () => {
    const classes = parsed.task_classes as Array<Record<string, unknown>>;
    const byId = Object.fromEntries(classes.map((c) => [c.id, c]));
    expect(byId['docs-or-local-config'].skill).toBeNull();
    expect(byId['cross-context-feature'].skill).toBe('/autoplan');
    expect(byId['bug-or-failure'].skill).toBe('/investigate');
    expect(byId['pr-ready-implementation'].skill).toBe('/review');
    expect(byId['browser-visible'].skill).toBe('/qa');
    expect(byId['security-sensitive'].skill).toBe('/cso');
    expect(byId['release'].skill).toBe('/ship');
    expect(byId['release'].gate).toBe('deploy');
  });

  test('generated_map declares itself non-authoritative', () => {
    const gm = parsed.generated_map as Record<string, unknown>;
    expect(gm.source_of_truth).toBe(false);
    expect(gm.output_dir).toBe('agent-work/generated');
  });

  test('no other scaffold template carries project facts', () => {
    // The engine/config split: only repo-map.yml may contain a project's own
    // contexts, commands, or document paths. The rest are repo-agnostic.
    for (const name of SCAFFOLD_TEMPLATES) {
      if (name === 'repo-map.yml.template') continue;
      const body = read(`templates/${name}`);
      expect(body, `${name} must not hardcode a project command`).not.toMatch(
        /\bnpm run (build|test|lint|typecheck)\b/,
      );
      expect(body, `${name} must not hardcode a URL`).not.toMatch(/https?:\/\/localhost/);
    }
  });
});

describe('icm-repo-cartographer routing prose', () => {
  const routing = read('templates/skill-routing.md.template');

  test('selection by risk and scope is stated, not implied', () => {
    expect(routing).toMatch(/by risk and scope, not ceremony/i);
    expect(routing).toMatch(/Never run every skill on every task/i);
  });

  test('the table is NOT restated here — it has one home, the YAML', () => {
    expect(routing).toMatch(/lives in `repo-map\.yml` under\s+`task_classes:`/);
    expect(routing).toMatch(/One home per fact/i);
    // A markdown table of classes here would be the duplication this guards against.
    expect(routing.match(/^\|.*\|$/gm) ?? []).toHaveLength(0);
  });

  test('the two rules people drop are called out explicitly', () => {
    expect(routing).toMatch(/Browser QA needs a runnable URL/i);
    expect(routing).toContain('commands.dev_url');
    expect(routing).toMatch(/Security review runs when the risk is real/i);
    expect(routing).toContain('/cso');
  });

  test('a release prepares a PR; merge and deploy need authorization', () => {
    expect(routing).toMatch(/may prepare a pull request/i);
    expect(routing).toMatch(/Merging and deploying always require\s+explicit authorization from the user/i);
    expect(routing).toMatch(/No earlier\s+approval carries forward/i);
  });

  test('skill: null is named as the common answer, not the exception', () => {
    expect(routing).toMatch(/`skill: null` is a real answer, and the most common one/i);
  });

  test('the routing file refuses to become an enforcement mechanism', () => {
    expect(routing).toMatch(
      /adds no scanner, no credential detector, no CI gate, no forced review loop, and\s+no pre-push hook/i,
    );
  });
});

describe('icm-repo-cartographer SKILL.md.tmpl', () => {
  const tmpl = fs.readFileSync(path.join(SKILL, 'SKILL.md.tmpl'), 'utf-8');

  test('inspects before it writes — the hard gate is in the source, not just the prose', () => {
    expect(tmpl).toMatch(/\*\*HARD GATE:\*\* do not write a single file before Phase 3 is approved/);
    const inspect = tmpl.indexOf('## Phase 1 — Inspect before you touch');
    const scaffold = tmpl.indexOf('## Phase 4 — Scaffold the bounded adapter');
    expect(inspect).toBeGreaterThan(-1);
    expect(scaffold).toBeGreaterThan(inspect);
  });

  test('classifies into exactly the three declared forms', () => {
    expect(tmpl).toMatch(/\*\*context map\*\*, \*\*pipeline\*\*, or \*\*composed\*\*/);
  });

  test('declares the eight-file scaffold and nothing more', () => {
    for (const p of [
      'AGENTS.md',
      'CLAUDE.md',
      'agent-work/',
      'repo-map.yml',
      'CONTEXT.md',
      '_system/skill-routing.md',
      '_templates/task-brief.md',
      'generated/',
      'agent-map.md',
      'agent-map.mmd',
    ]) {
      expect(tmpl).toContain(p);
    }
    expect(tmpl).toMatch(/do not add a ninth/i);
  });

  test('refuses scanners, gates, forced loops and pre-push hooks by name', () => {
    expect(tmpl).toMatch(
      /A scanner, a credential detector, a CI gate, a forced review loop, or a\s+mandatory pre-push hook/i,
    );
    expect(tmpl).toMatch(/no hooks, no CI gates, no\s+blocking mechanisms — by design, not by omission/i);
  });

  test('refuses speculative structure and a browser dependency', () => {
    expect(tmpl).toMatch(/No stage folders for stages that do not exist, no\s+empty buckets, no knowledge base/i);
    expect(tmpl).toMatch(/No 3D app, no\s+image assets, no browser dependency/i);
  });

  test('requires a licence check and approval before borrowing any code', () => {
    expect(tmpl).toMatch(
      /inspect the licence of any source you would borrow from and stop for the\s+user's approval before copying a single line of it/i,
    );
  });

  test('states the engine/configuration split and the map-is-a-view rule', () => {
    expect(tmpl).toMatch(/One reusable engine, one project-specific configuration file/i);
    expect(tmpl).toMatch(/\*\*The map is a view, never a source of truth\.\*\*/);
  });

  test('names the generator and the check mode', () => {
    expect(tmpl).toContain('gstack-agent-map.ts');
    expect(tmpl).toContain('--check');
    expect(tmpl).toMatch(/Fix the YAML — never the generated file/i);
  });

  test('never overwrites an entry file without asking', () => {
    expect(tmpl).toMatch(/Never silently overwrite an entry file/i);
  });

  test('generation wiring produced a SKILL.md carrying the walk test', () => {
    const generated = read('SKILL.md');
    expect(generated).toContain('AUTO-GENERATED from SKILL.md.tmpl');
    expect(generated).toContain('## Phase 7 — Walk the workspace cold');
    expect(generated).toContain('bin/gstack-agent-map.ts');
  });
});

describe('the shipped template is a valid configuration once filled in', () => {
  test('substituting the placeholders yields a config the validator accepts', () => {
    // The template ships with quoted placeholders so it stays parseable; this
    // proves it is also SEMANTICALLY complete, not merely well-formed YAML.
    const filled = read('templates/repo-map.yml.template')
      .replace('"{REPO_NAME}"', 'sample')
      .replace('"{context-map|pipeline|composed}"', 'composed')
      .replace('"{doc-id}"', 'readme')
      .replace('"{PATH/TO/DOC.md}"', 'README.md')
      .replace('"{the question this document is the answer to}"', 'what this repo is')
      .replace('"{the trigger that makes it worth the tokens}"', 'first contact')
      .replace('"{context-name}"', 'core')
      .replace('"{one line: what this part of the repo is responsible for}"', 'everything, for now')
      .replace('"{src/path/one}"', 'src')
      .replace('"{src}"', 'src')
      .replace('"{path/that/needs/a/gate}"', 'db/migrations')
      .replace('"{what breaks if this changes without review}"', 'shared database')
      .replace('"{gate-id}"', 'deploy');

    const map = parseRepoMap(filled);
    expect(map.project.name).toBe('sample');
    expect(map.contexts).toHaveLength(1);
    expect(map.task_classes.some((tc) => tc.skill === null)).toBe(true);
  });
});
