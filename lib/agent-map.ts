/**
 * agent-map — render an ICM agent context map from `agent-work/repo-map.yml`.
 *
 * The YAML is the canonical source of truth. Everything this module emits is a
 * VIEW of it: reproducible, never authoritative, and stamped as such in the
 * output so a reader who opens the map alone cannot mistake it for the config.
 *
 * Determinism is a hard requirement — identical YAML in, byte-identical map out.
 * That means no timestamps, no clock, no hashes of anything but the input text,
 * no iteration over unordered sets, and no dependence on filesystem order.
 * Reproducibility is what lets a check tell drift from noise.
 *
 * Validation is fail-loud and actionable: every error names the field path, what
 * was found, and the edit that fixes it. A config file that fails with "invalid
 * input" teaches nobody anything.
 */

export const REPO_MAP_SCHEMA = 'icm-repo-cartographer/v1';

/** The four risk markers are a fixed set — an open one drifts into a taxonomy nobody maintains. */
export const RISK_MARKER_KEYS = ['auth', 'tenant_isolation', 'billing', 'externally_reachable'] as const;

export const PROJECT_FORMS = ['context-map', 'pipeline', 'composed'] as const;

export const GENERATED_BANNER =
  'GENERATED FROM agent-work/repo-map.yml — DO NOT EDIT, AND DO NOT TREAT AS SOURCE OF TRUTH.';

export interface SourceOfTruth {
  id: string;
  path: string;
  holds: string;
  read_when: string;
}

export interface BoundedContext {
  name: string;
  purpose: string;
  paths: string[];
  sources_of_truth: string[];
  depends_on: string[];
  risk: string[];
}

export interface ProtectedBoundary {
  paths: string[];
  why: string;
  gate: string;
}

export interface TaskClass {
  id: string;
  when: string;
  skill: string | null;
  gate: string | null;
  note?: string;
}

export interface Gate {
  id: string;
  when: string;
  requires: string;
  authority: string;
  self_clearable: boolean;
}

export interface RepoMap {
  schema: string;
  project: {
    name: string;
    form: (typeof PROJECT_FORMS)[number];
    entry: string;
    stack: Record<string, unknown>;
  };
  sources_of_truth: SourceOfTruth[];
  contexts: BoundedContext[];
  boundaries: { allowed: string[]; protected: ProtectedBoundary[] };
  commands: Record<string, string | null>;
  task_classes: TaskClass[];
  gates: Gate[];
  risk_markers: Record<string, string[]>;
  generated_map: {
    output_dir: string;
    mermaid: string;
    markdown: string;
    direction: string;
    source_of_truth: boolean;
  };
}

/** Carries the field path so a caller can point at the exact line to edit. */
export class RepoMapError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`repo-map.yml: ${field} — ${message}`);
    this.name = 'RepoMapError';
  }
}

const fail = (field: string, message: string): never => {
  throw new RepoMapError(field, message);
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function requireString(value: unknown, field: string, hint: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(field, `expected a non-empty string, found ${describe(value)}. ${hint}`);
  }
  return (value as string).trim();
}

function requireStringList(value: unknown, field: string, hint: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(field, `expected a list, found ${describe(value)}. ${hint}`);
  return (value as unknown[]).map((entry, i) => requireString(entry, `${field}[${i}]`, hint));
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return `a list of ${value.length}`;
  return typeof value;
}

/**
 * Parse and validate. Throws RepoMapError naming the field and the fix.
 *
 * Validation is deliberately strict about cross-references — an id in
 * `contexts[].sources_of_truth` that resolves to nothing is exactly the kind of
 * rot that makes an agent read a file that no longer exists.
 */
export function parseRepoMap(text: string): RepoMap {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (err) {
    fail('(whole file)', `not valid YAML — ${(err as Error).message}. Fix the syntax, then re-run the map generator.`);
  }
  if (!isPlainObject(raw)) {
    fail('(whole file)', `expected a mapping at the top level, found ${describe(raw)}. The file may be empty.`);
  }
  const doc = raw as Record<string, unknown>;

  if (doc.schema !== REPO_MAP_SCHEMA) {
    fail(
      'schema',
      `expected "${REPO_MAP_SCHEMA}", found ${JSON.stringify(doc.schema ?? null)}. ` +
        `Set it, or migrate the file if it was written for an older engine.`,
    );
  }

  // ─── project ──────────────────────────────────────────────────────────────
  if (!isPlainObject(doc.project)) {
    fail('project', `expected a mapping with name, form and entry, found ${describe(doc.project)}.`);
  }
  const projectRaw = doc.project as Record<string, unknown>;
  const name = requireString(projectRaw.name, 'project.name', 'This is the repository name.');
  const form = requireString(projectRaw.form, 'project.form', `One of: ${PROJECT_FORMS.join(', ')}.`);
  if (!(PROJECT_FORMS as readonly string[]).includes(form)) {
    fail('project.form', `"${form}" is not a known form. Use one of: ${PROJECT_FORMS.join(', ')}.`);
  }
  const entry = requireString(projectRaw.entry, 'project.entry', 'Normally AGENTS.md.');
  if ('summary' in projectRaw) {
    fail(
      'project.summary',
      `remove it. "What is this repo and what ships out of it" belongs in ${entry} and only there — ` +
        `a sentence stored twice is the first fact to drift, and it drifts silently.`,
    );
  }

  // ─── sources_of_truth ─────────────────────────────────────────────────────
  if (!Array.isArray(doc.sources_of_truth) || doc.sources_of_truth.length === 0) {
    fail(
      'sources_of_truth',
      `expected a non-empty list. A repository with no source-of-truth document is one an agent has to guess at.`,
    );
  }
  const sources: SourceOfTruth[] = (doc.sources_of_truth as unknown[]).map((entry, i) => {
    const at = `sources_of_truth[${i}]`;
    if (!isPlainObject(entry)) fail(at, `expected a mapping, found ${describe(entry)}.`);
    const e = entry as Record<string, unknown>;
    return {
      id: requireString(e.id, `${at}.id`, 'A short stable id; contexts reference it.'),
      path: requireString(e.path, `${at}.path`, 'A document that exists today.'),
      holds: requireString(e.holds, `${at}.holds`, 'The question this document answers.'),
      read_when: requireString(e.read_when, `${at}.read_when`, 'The trigger that makes it worth the tokens.'),
    };
  });
  const seenSourceIds = new Set<string>();
  for (const s of sources) {
    if (seenSourceIds.has(s.id)) {
      fail('sources_of_truth', `duplicate id "${s.id}". Ids must be unique — contexts resolve documents by id.`);
    }
    seenSourceIds.add(s.id);
  }

  // ─── risk_markers (validated early; contexts reference the keys) ──────────
  if (!isPlainObject(doc.risk_markers)) {
    fail('risk_markers', `expected a mapping with exactly: ${RISK_MARKER_KEYS.join(', ')}.`);
  }
  const markerKeys = Object.keys(doc.risk_markers as Record<string, unknown>).sort();
  const expectedKeys = [...RISK_MARKER_KEYS].sort();
  if (markerKeys.join(',') !== expectedKeys.join(',')) {
    fail(
      'risk_markers',
      `keys must be exactly ${expectedKeys.join(', ')} — found ${markerKeys.join(', ') || '(none)'}. ` +
        `The set is fixed on purpose; an empty list is the right way to say a surface does not exist here.`,
    );
  }
  const riskMarkers: Record<string, string[]> = {};
  for (const key of RISK_MARKER_KEYS) {
    riskMarkers[key] = requireStringList(
      (doc.risk_markers as Record<string, unknown>)[key],
      `risk_markers.${key}`,
      'A list of path fragments or literals, or [] when this repo has no such surface.',
    );
  }

  // ─── gates (validated before the things that reference them) ──────────────
  if (!Array.isArray(doc.gates) || doc.gates.length === 0) {
    fail('gates', `expected a non-empty list containing at least the "deploy" gate.`);
  }
  const gates: Gate[] = (doc.gates as unknown[]).map((entry, i) => {
    const at = `gates[${i}]`;
    if (!isPlainObject(entry)) fail(at, `expected a mapping, found ${describe(entry)}.`);
    const e = entry as Record<string, unknown>;
    if (typeof e.self_clearable !== 'boolean') {
      fail(`${at}.self_clearable`, `expected true or false, found ${describe(e.self_clearable)}.`);
    }
    return {
      id: requireString(e.id, `${at}.id`, 'A short stable id; task classes and boundaries reference it.'),
      when: requireString(e.when, `${at}.when`, 'The condition that reaches this gate.'),
      requires: requireString(e.requires, `${at}.requires`, 'What must happen before work proceeds.'),
      authority: requireString(e.authority, `${at}.authority`, 'Who clears it — normally "user".'),
      self_clearable: e.self_clearable as boolean,
    };
  });
  const gateIds = new Set(gates.map((g) => g.id));
  const deploy = gates.find((g) => g.id === 'deploy');
  if (!deploy) {
    fail('gates', `must contain a gate with id "deploy". Deployment authority is not optional.`);
  }
  if (deploy!.self_clearable !== false) {
    fail('gates[deploy].self_clearable', `must be false. An agent never clears its own deployment gate.`);
  }
  if (deploy!.authority !== 'user') {
    fail(
      'gates[deploy].authority',
      `must be "user", found ${JSON.stringify(deploy!.authority)}. Merging and deploying need explicit user authorization, every time.`,
    );
  }

  // ─── contexts ─────────────────────────────────────────────────────────────
  if (!Array.isArray(doc.contexts) || doc.contexts.length === 0) {
    fail('contexts', `expected a non-empty list. At least one bounded context or major module must be named.`);
  }
  const contexts: BoundedContext[] = (doc.contexts as unknown[]).map((entry, i) => {
    const at = `contexts[${i}]`;
    if (!isPlainObject(entry)) fail(at, `expected a mapping, found ${describe(entry)}.`);
    const e = entry as Record<string, unknown>;
    const ctxName = requireString(e.name, `${at}.name`, 'The word the team actually uses.');
    const paths = requireStringList(e.paths, `${at}.paths`, 'Path prefixes owned by this context.');
    if (paths.length === 0) {
      fail(`${at}.paths`, `expected at least one path. A context that owns no paths cannot be routed to.`);
    }
    return {
      name: ctxName,
      purpose: requireString(e.purpose, `${at}.purpose`, 'One line: what this part of the repo is responsible for.'),
      paths,
      sources_of_truth: requireStringList(e.sources_of_truth, `${at}.sources_of_truth`, 'Ids from the top-level list.'),
      depends_on: requireStringList(e.depends_on, `${at}.depends_on`, 'Other context names.'),
      risk: requireStringList(e.risk, `${at}.risk`, `Any of: ${RISK_MARKER_KEYS.join(', ')}.`),
    };
  });
  const contextNames = new Set(contexts.map((c) => c.name));
  for (const ctx of contexts) {
    for (const id of ctx.sources_of_truth) {
      if (!seenSourceIds.has(id)) {
        fail(
          `contexts[${ctx.name}].sources_of_truth`,
          `"${id}" does not match any sources_of_truth id. Known ids: ${[...seenSourceIds].join(', ')}.`,
        );
      }
    }
    for (const dep of ctx.depends_on) {
      if (!contextNames.has(dep)) {
        fail(
          `contexts[${ctx.name}].depends_on`,
          `"${dep}" is not a known context name. Known contexts: ${[...contextNames].join(', ')}.`,
        );
      }
      if (dep === ctx.name) {
        fail(`contexts[${ctx.name}].depends_on`, `a context cannot depend on itself.`);
      }
    }
    for (const marker of ctx.risk) {
      if (!(RISK_MARKER_KEYS as readonly string[]).includes(marker)) {
        fail(
          `contexts[${ctx.name}].risk`,
          `"${marker}" is not a risk marker. Use one of: ${RISK_MARKER_KEYS.join(', ')}.`,
        );
      }
    }
  }

  // ─── boundaries ───────────────────────────────────────────────────────────
  if (!isPlainObject(doc.boundaries)) {
    fail('boundaries', `expected a mapping with "allowed" and "protected".`);
  }
  const boundariesRaw = doc.boundaries as Record<string, unknown>;
  const allowed = requireStringList(boundariesRaw.allowed, 'boundaries.allowed', 'Paths an agent may change under the normal rules.');
  const protectedRaw = boundariesRaw.protected;
  if (protectedRaw !== undefined && protectedRaw !== null && !Array.isArray(protectedRaw)) {
    fail('boundaries.protected', `expected a list, found ${describe(protectedRaw)}.`);
  }
  const protectedBoundaries: ProtectedBoundary[] = ((protectedRaw as unknown[]) ?? []).map((entry, i) => {
    const at = `boundaries.protected[${i}]`;
    if (!isPlainObject(entry)) fail(at, `expected a mapping, found ${describe(entry)}.`);
    const e = entry as Record<string, unknown>;
    const gate = requireString(e.gate, `${at}.gate`, `A gate id. Known gates: ${[...gateIds].join(', ')}.`);
    if (!gateIds.has(gate)) {
      fail(`${at}.gate`, `"${gate}" is not a known gate id. Known gates: ${[...gateIds].join(', ')}.`);
    }
    const paths = requireStringList(e.paths, `${at}.paths`, 'The protected path prefixes.');
    if (paths.length === 0) fail(`${at}.paths`, `expected at least one path, or drop the entry.`);
    return {
      paths,
      why: requireString(e.why, `${at}.why`, 'What breaks if this changes without review.'),
      gate,
    };
  });

  // ─── commands ─────────────────────────────────────────────────────────────
  if (!isPlainObject(doc.commands)) {
    fail('commands', `expected a mapping. Use null for a command this repo does not have.`);
  }
  const commands: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(doc.commands as Record<string, unknown>)) {
    if (value === null || value === undefined) {
      commands[key] = null;
      continue;
    }
    if (typeof value !== 'string') {
      fail(`commands.${key}`, `expected a string or null, found ${describe(value)}.`);
    }
    commands[key] = (value as string).trim() === '' ? null : (value as string).trim();
  }

  // ─── task_classes ─────────────────────────────────────────────────────────
  if (!Array.isArray(doc.task_classes) || doc.task_classes.length === 0) {
    fail('task_classes', `expected a non-empty list. This is the canonical routing table.`);
  }
  const taskClasses: TaskClass[] = (doc.task_classes as unknown[]).map((entry, i) => {
    const at = `task_classes[${i}]`;
    if (!isPlainObject(entry)) fail(at, `expected a mapping, found ${describe(entry)}.`);
    const e = entry as Record<string, unknown>;
    const id = requireString(e.id, `${at}.id`, 'A short stable id for this class of work.');
    let skill: string | null = null;
    if (e.skill !== null && e.skill !== undefined) {
      skill = requireString(e.skill, `${at}.skill`, 'A gstack skill like /review, or null for no mandatory workflow.');
      if (!skill.startsWith('/')) {
        fail(`${at}.skill`, `"${skill}" must start with "/" (for example /review), or be null.`);
      }
    }
    let gate: string | null = null;
    if (e.gate !== null && e.gate !== undefined) {
      gate = requireString(e.gate, `${at}.gate`, `A gate id. Known gates: ${[...gateIds].join(', ')}.`);
      if (!gateIds.has(gate)) {
        fail(`${at}.gate`, `"${gate}" is not a known gate id. Known gates: ${[...gateIds].join(', ')}.`);
      }
    }
    const result: TaskClass = {
      id,
      when: requireString(e.when, `${at}.when`, 'The condition that selects this class.'),
      skill,
      gate,
    };
    if (e.note !== undefined && e.note !== null) {
      result.note = requireString(e.note, `${at}.note`, 'Optional clarification.');
    }
    return result;
  });
  const seenClassIds = new Set<string>();
  for (const tc of taskClasses) {
    if (seenClassIds.has(tc.id)) fail('task_classes', `duplicate id "${tc.id}". Ids must be unique.`);
    seenClassIds.add(tc.id);
  }
  if (!taskClasses.some((tc) => tc.skill === null)) {
    fail(
      'task_classes',
      `at least one class must have skill: null. A routing table where every change earns a workflow is ceremony, not routing.`,
    );
  }

  // ─── generated_map ────────────────────────────────────────────────────────
  if (!isPlainObject(doc.generated_map)) {
    fail('generated_map', `expected a mapping with output_dir, mermaid, markdown, direction and source_of_truth.`);
  }
  const gm = doc.generated_map as Record<string, unknown>;
  if (gm.source_of_truth !== false) {
    fail(
      'generated_map.source_of_truth',
      `must be false. The map is rendered FROM this file and is never authoritative — if they disagree, this file wins.`,
    );
  }
  const direction = requireString(gm.direction, 'generated_map.direction', 'A Mermaid direction such as LR or TD.');
  if (!['LR', 'RL', 'TD', 'TB', 'BT'].includes(direction)) {
    fail('generated_map.direction', `"${direction}" is not a Mermaid direction. Use LR, RL, TD, TB or BT.`);
  }

  return {
    schema: REPO_MAP_SCHEMA,
    project: {
      name,
      form: form as (typeof PROJECT_FORMS)[number],
      entry,
      stack: isPlainObject(projectRaw.stack) ? (projectRaw.stack as Record<string, unknown>) : {},
    },
    sources_of_truth: sources,
    contexts,
    boundaries: { allowed, protected: protectedBoundaries },
    commands,
    task_classes: taskClasses,
    gates,
    risk_markers: riskMarkers,
    generated_map: {
      output_dir: requireString(gm.output_dir, 'generated_map.output_dir', 'Where the rendered files go.'),
      mermaid: requireString(gm.mermaid, 'generated_map.mermaid', 'Filename for the Mermaid source.'),
      markdown: requireString(gm.markdown, 'generated_map.markdown', 'Filename for the readable map.'),
      direction,
      source_of_truth: false,
    },
  };
}

/** Mermaid node ids must be identifier-safe and stable for the same input. */
function nodeId(prefix: string, value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${prefix}_${slug || 'x'}`;
}

/** Mermaid labels live inside quotes; strip what would break the quoting. */
function label(text: string): string {
  return text.replace(/["\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

const RISK_LABEL: Record<string, string> = {
  auth: 'auth',
  tenant_isolation: 'tenant isolation',
  billing: 'billing',
  externally_reachable: 'externally reachable',
};

/**
 * Render the Mermaid source. Deterministic: declaration order is preserved and
 * nothing outside the input influences the output.
 */
export function renderMermaid(map: RepoMap): string {
  const out: string[] = [];
  const dir = map.generated_map.direction;

  out.push(`%% ${GENERATED_BANNER}`);
  out.push(`%% schema: ${map.schema}`);
  out.push(`flowchart ${dir}`);

  // Bounded contexts and the edges between them.
  out.push(`  subgraph CONTEXTS["Bounded contexts — ${label(map.project.name)} (${map.project.form})"]`);
  for (const ctx of map.contexts) {
    const risks = ctx.risk.map((r) => RISK_LABEL[r] ?? r).join(', ');
    const suffix = risks ? `<br/><i>risk: ${risks}</i>` : '';
    out.push(`    ${nodeId('ctx', ctx.name)}["<b>${label(ctx.name)}</b><br/>${label(ctx.purpose)}${suffix}"]`);
  }
  out.push('  end');

  const edges: string[] = [];
  for (const ctx of map.contexts) {
    for (const dep of ctx.depends_on) {
      edges.push(`  ${nodeId('ctx', ctx.name)} --> ${nodeId('ctx', dep)}`);
    }
  }
  if (edges.length > 0) out.push(...edges);

  // Source-of-truth documents, linked from the contexts that name them.
  out.push('  subgraph DOCS["Source of truth"]');
  for (const doc of map.sources_of_truth) {
    out.push(`    ${nodeId('sot', doc.id)}[("${label(doc.path)}<br/><i>${label(doc.holds)}</i>")]`);
  }
  out.push('  end');
  for (const ctx of map.contexts) {
    for (const id of ctx.sources_of_truth) {
      out.push(`  ${nodeId('ctx', ctx.name)} -.reads.-> ${nodeId('sot', id)}`);
    }
  }

  // Human gates. Declared before anything that points at them: Mermaid places a
  // node where it is FIRST mentioned, so an edge written earlier would drag the
  // gate out of this subgraph and quietly break the grouping.
  out.push('  subgraph GATES["Human gates — an agent never clears its own"]');
  for (const gate of map.gates) {
    out.push(
      `    ${nodeId('gate', gate.id)}>"<b>${label(gate.id)}</b><br/>${label(gate.requires)}<br/><i>authority: ${label(gate.authority)}</i>"]`,
    );
  }
  out.push('  end');

  // Protected boundaries, each pointing at the gate that guards it.
  if (map.boundaries.protected.length > 0) {
    out.push('  subgraph PROTECTED["Protected boundaries"]');
    map.boundaries.protected.forEach((b, i) => {
      out.push(`    ${nodeId('prot', String(i))}{{"${label(b.paths.join(', '))}<br/><i>${label(b.why)}</i>"}}`);
    });
    out.push('  end');
    map.boundaries.protected.forEach((b, i) => {
      out.push(`  ${nodeId('prot', String(i))} ==> ${nodeId('gate', b.gate)}`);
    });
  }

  // The routing decision path.
  out.push('  subgraph ROUTING["Task routing — by risk and scope, not ceremony"]');
  out.push('    START{{"a change is proposed"}}');
  for (const tc of map.task_classes) {
    const target = tc.skill ? `→ <b>${label(tc.skill)}</b>` : '→ <b>no mandatory workflow</b>';
    out.push(`    ${nodeId('tc', tc.id)}["${label(tc.when)}<br/>${target}"]`);
  }
  out.push('  end');
  for (const tc of map.task_classes) {
    out.push(`  START --> ${nodeId('tc', tc.id)}`);
  }

  // Which task classes reach a gate. The gates themselves are declared above.
  for (const tc of map.task_classes) {
    if (tc.gate) out.push(`  ${nodeId('tc', tc.id)} ==> ${nodeId('gate', tc.gate)}`);
  }

  // Styling: gates and protected boundaries are the things a reader must not miss.
  out.push('  classDef gate stroke-width:3px;');
  out.push('  classDef protectedBoundary stroke-dasharray: 4 3;');
  const gateNodes = map.gates.map((g) => nodeId('gate', g.id));
  if (gateNodes.length > 0) out.push(`  class ${gateNodes.join(',')} gate;`);
  if (map.boundaries.protected.length > 0) {
    const protNodes = map.boundaries.protected.map((_, i) => nodeId('prot', String(i)));
    out.push(`  class ${protNodes.join(',')} protectedBoundary;`);
  }

  return out.join('\n') + '\n';
}

const commandRow = (key: string, value: string | null): string =>
  `| \`${key}\` | ${value ? `\`${value}\`` : '_not set_'} |`;

/**
 * Render the readable map page. Leads with the banner so a reader who arrives
 * here first learns immediately that this is a view, not the config.
 */
export function renderMarkdown(map: RepoMap, mermaid: string): string {
  const out: string[] = [];

  out.push(`# ${map.project.name} — agent context map`);
  out.push('');
  out.push(`> **${GENERATED_BANNER}**`);
  out.push('>');
  out.push(
    '> The canonical source is `agent-work/repo-map.yml`. This page is rendered from it. ' +
      'If the two disagree, the YAML wins and this page is stale — regenerate it rather than editing it.',
  );
  out.push('');
  out.push(`Form: **${map.project.form}**. Entry file: \`${map.project.entry}\`.`);
  out.push('');

  out.push('## The map');
  out.push('');
  out.push('```mermaid');
  out.push(mermaid.trimEnd());
  out.push('```');
  out.push('');

  out.push('## Bounded contexts');
  out.push('');
  out.push('| Context | Purpose | Paths | Risk |');
  out.push('|---|---|---|---|');
  for (const ctx of map.contexts) {
    const risks = ctx.risk.map((r) => RISK_LABEL[r] ?? r).join(', ') || '—';
    out.push(
      `| **${ctx.name}** | ${ctx.purpose} | ${ctx.paths.map((p) => `\`${p}\``).join(', ')} | ${risks} |`,
    );
  }
  out.push('');

  out.push('## Source of truth');
  out.push('');
  out.push('| Document | Holds | Read when |');
  out.push('|---|---|---|');
  for (const doc of map.sources_of_truth) {
    out.push(`| \`${doc.path}\` | ${doc.holds} | ${doc.read_when} |`);
  }
  out.push('');

  if (map.boundaries.protected.length > 0) {
    out.push('## Protected boundaries');
    out.push('');
    out.push('| Paths | Why | Gate |');
    out.push('|---|---|---|');
    for (const b of map.boundaries.protected) {
      out.push(`| ${b.paths.map((p) => `\`${p}\``).join(', ')} | ${b.why} | **${b.gate}** |`);
    }
    out.push('');
  }

  out.push('## Task routing');
  out.push('');
  out.push('Selection follows risk and scope. Never run every skill on every task.');
  out.push('');
  out.push('| When | Route | Gate |');
  out.push('|---|---|---|');
  for (const tc of map.task_classes) {
    const route = tc.skill ? `\`${tc.skill}\`` : '_no mandatory workflow_';
    const note = tc.note ? `<br/><sub>${tc.note}</sub>` : '';
    out.push(`| ${tc.when}${note} | ${route} | ${tc.gate ? `**${tc.gate}**` : '—'} |`);
  }
  out.push('');

  out.push('## Human gates');
  out.push('');
  for (const gate of map.gates) {
    out.push(`- **${gate.id}** — ${gate.when}. Requires: ${gate.requires} Authority: **${gate.authority}**.`);
  }
  out.push('');

  out.push('## Commands');
  out.push('');
  out.push('| Intent | Command |');
  out.push('|---|---|');
  for (const key of Object.keys(map.commands)) {
    out.push(commandRow(key, map.commands[key]));
  }
  out.push('');

  return out.join('\n');
}

export interface RenderedMap {
  mermaid: string;
  markdown: string;
}

/** Convenience: YAML text in, both rendered files out. */
export function renderAgentMap(yamlText: string): RenderedMap {
  const map = parseRepoMap(yamlText);
  const mermaid = renderMermaid(map);
  return { mermaid, markdown: renderMarkdown(map, mermaid) };
}
