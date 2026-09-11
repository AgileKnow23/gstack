/**
 * /icm-repo-workspace scaffold pins (free, static).
 *
 * The skill's whole value is that the adapter it leaves behind stays small and
 * stays honest. Three properties are load-bearing and all three are easy to
 * erode by a well-meaning edit:
 *
 *   1. AGENTS.md is a router, under 60 lines, carrying pointers and no content.
 *   2. CLAUDE.md is a pointer, never a second copy — two entry files that both
 *      carry content drift, and the day they disagree neither is trustworthy.
 *   3. repo-map.yml is the ONLY project-specific file. One reusable engine, one
 *      project-specific configuration file.
 *
 * These assertions pin the templates so a refactor cannot quietly turn the
 * router into a document or spread project facts across the scaffold.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(import.meta.dir, '..');
const SKILL = path.join(ROOT, 'icm-repo-workspace');
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

describe('icm-repo-workspace scaffold templates', () => {
  test('ships exactly the six scaffold starters — not a seventh', () => {
    const found = fs.readdirSync(path.join(SKILL, 'templates')).sort();
    expect(found).toEqual([...SCAFFOLD_TEMPLATES].sort());
  });

  test('AGENTS.md router stays under 60 lines', () => {
    // The ICM invariant: a small, stable entry file that routes and never holds
    // content. 60 is the ceiling, not the target.
    expect(lines(read('templates/AGENTS.md.template'))).toBeLessThan(60);
  });

  test('AGENTS.md points at all four workspace paths and restates none of them', () => {
    const agents = read('templates/AGENTS.md.template');
    for (const p of [
      'agent-work/repo-map.yml',
      'agent-work/CONTEXT.md',
      'agent-work/_system/skill-routing.md',
      'agent-work/_templates/task-brief.md',
    ]) {
      expect(agents).toContain(p);
    }
    // The router must defer the doc list to repo-map.yml rather than copy it.
    expect(agents).toContain('sources_of_truth:');
    expect(agents).toMatch(/do not restate them here/i);
  });

  test('AGENTS.md carries the deploy gate and the route-by-risk rule', () => {
    const agents = read('templates/AGENTS.md.template');
    expect(agents).toMatch(/Deployment requires explicit authorization from the user, every time/);
    expect(agents).toMatch(/never carries forward/i);
    expect(agents).toMatch(/Route by risk, never by ritual/i);
  });

  test('CLAUDE.md is a pointer, not a second router', () => {
    const claude = read('templates/CLAUDE.md.template');
    expect(claude).toContain('AGENTS.md');
    // Short by construction. A pointer that needs 30 lines is a document.
    expect(lines(claude)).toBeLessThan(20);
    // None of the router's structure may appear here.
    expect(claude).not.toContain('## Where things live');
    expect(claude).not.toContain('## Route by what you were asked to do');
    expect(claude).not.toContain('agent-work/_system/skill-routing.md');
    expect(claude).toMatch(/one home per fact/i);
  });
});

describe('icm-repo-workspace repo-map.yml is the only project-specific file', () => {
  const raw = read('templates/repo-map.yml.template');
  const parsed = Bun.YAML.parse(raw) as Record<string, unknown>;

  test('the template itself is valid YAML (a config nobody can parse is a config nobody read)', () => {
    expect(parsed).toBeTruthy();
    expect(typeof parsed).toBe('object');
  });

  test('carries the schema pin and the required top-level keys', () => {
    expect(parsed.schema).toBe('icm-repo-workspace/v1');
    for (const key of [
      'repo',
      'sources_of_truth',
      'domains',
      'commands',
      'gates',
      'risk_markers',
    ]) {
      expect(Object.keys(parsed)).toContain(key);
    }
  });

  test('carries no repo summary — that sentence has one home, the entry file', () => {
    // "Where am I" must be answerable from AGENTS.md alone, so the summary lives
    // there and nowhere else. A sentence stored twice is the first fact to drift,
    // and it drifts silently because nobody diffs a sentence.
    const repo = parsed.repo as Record<string, unknown>;
    expect(Object.keys(repo).sort()).toEqual(['entry', 'form', 'name']);
    expect(raw).toMatch(/No summary here on purpose/i);
  });

  test('risk_markers is a fixed four-key set — an open set drifts into an unmaintained taxonomy', () => {
    const markers = parsed.risk_markers as Record<string, unknown>;
    expect(Object.keys(markers).sort()).toEqual([
      'auth',
      'billing',
      'externally_reachable',
      'tenant_isolation',
    ]);
  });

  test('the deploy gate ships mandatory and not self-clearable', () => {
    const gates = parsed.gates as Array<Record<string, unknown>>;
    const deploy = gates.find((g) => g.id === 'deploy');
    expect(deploy).toBeDefined();
    expect(deploy!.self_clearable).toBe(false);
    expect(String(deploy!.requires)).toMatch(/explicit user authorization/i);
    expect(String(deploy!.requires)).toMatch(/never carries forward/i);
  });

  test('dev_url ships null so browser QA skips explicitly rather than accidentally', () => {
    const commands = parsed.commands as Record<string, unknown>;
    expect(commands.dev_url).toBeNull();
  });

  test('no other scaffold template carries project facts', () => {
    // The engine/config split: only repo-map.yml may contain a project's own
    // domains, commands, or document paths. The rest are repo-agnostic.
    for (const name of SCAFFOLD_TEMPLATES) {
      if (name === 'repo-map.yml.template') continue;
      const body = read(`templates/${name}`);
      expect(body, `${name} must not hardcode a project command`).not.toMatch(
        /\bnpm run (build|test|lint)\b/,
      );
      expect(body, `${name} must not hardcode a URL`).not.toMatch(/https?:\/\/localhost/);
    }
  });
});

describe('icm-repo-workspace routing rules', () => {
  const routing = read('templates/skill-routing.md.template');

  test('route by risk, never by ritual is stated, not implied', () => {
    expect(routing).toMatch(/by risk, never by ritual/i);
  });

  test('all eight routing outcomes are present', () => {
    // Seven rules plus the explicit no-URL skip, which is the one people drop.
    expect(routing).toMatch(/No review pipeline/i);
    expect(routing).toContain('/autoplan');
    expect(routing).toContain('/plan-eng-review');
    expect(routing).toContain('/investigate');
    expect(routing).toContain('/review');
    expect(routing).toContain('/qa');
    expect(routing).toContain('/qa-only');
    expect(routing).toContain('/cso');
    expect(routing).toContain('/land-and-deploy');
  });

  test('QA is gated on a runnable URL in both directions', () => {
    expect(routing).toContain('commands.dev_url');
    expect(routing).toMatch(/Skip QA/i);
  });

  test('cso runs only on explicit request or a named risk marker', () => {
    expect(routing).toMatch(/only when the user explicitly asks for it, or the risk classification names/i);
    expect(routing).toMatch(/## What "explicitly requested" means/);
  });

  test('deployment stops for authorization every time', () => {
    expect(routing).toMatch(/STOP\. Explicit user authorization, every time/);
  });

  test('rows add rather than override', () => {
    // Wrapped prose: match across the line break rather than pinning the wrap point.
    expect(routing).toMatch(/they add, they do not\s+override/i);
  });

  test('the routing file refuses to become an enforcement mechanism', () => {
    expect(routing).toMatch(/does not add a scanner, a credential detector, a CI gate, or a hook/i);
  });
});

describe('icm-repo-workspace SKILL.md.tmpl', () => {
  const tmpl = fs.readFileSync(path.join(SKILL, 'SKILL.md.tmpl'), 'utf-8');

  test('inspects before it writes — the hard gate is in the source, not just the prose', () => {
    expect(tmpl).toMatch(/\*\*HARD GATE:\*\* do not write a single file before Phase 3 is approved/);
    const inspect = tmpl.indexOf('## Phase 1 — Inspect before you touch');
    const scaffold = tmpl.indexOf('## Phase 4 — Scaffold the minimum adapter');
    expect(inspect).toBeGreaterThan(-1);
    expect(scaffold).toBeGreaterThan(inspect);
  });

  test('classifies into exactly the three declared forms', () => {
    expect(tmpl).toMatch(/\*\*context map\*\*, \*\*pipeline\*\*, or \*\*composed\*\*/);
  });

  test('declares the six-file scaffold and nothing more', () => {
    for (const p of [
      'AGENTS.md',
      'CLAUDE.md',
      'agent-work/',
      'repo-map.yml',
      'CONTEXT.md',
      '_system/skill-routing.md',
      '_templates/task-brief.md',
    ]) {
      expect(tmpl).toContain(p);
    }
    expect(tmpl).toMatch(/do not add a seventh/i);
  });

  test('refuses scanners, detectors, CI gates, and hooks by name', () => {
    expect(tmpl).toMatch(/A scanner, a credential detector, a CI gate, or a hook/i);
    expect(tmpl).toMatch(/no hooks, no CI gates, no\s+blocking mechanisms — by design, not by omission/i);
  });

  test('states the engine/configuration split', () => {
    expect(tmpl).toMatch(/One reusable engine, one project-specific configuration file/i);
  });

  test('never overwrites an entry file without asking', () => {
    expect(tmpl).toMatch(/Never silently overwrite an entry file/i);
  });

  test('generation wiring produced a SKILL.md carrying the walk test', () => {
    const generated = read('SKILL.md');
    expect(generated).toContain('AUTO-GENERATED from SKILL.md.tmpl');
    expect(generated).toContain('## Phase 6 — Walk the workspace cold');
  });
});
