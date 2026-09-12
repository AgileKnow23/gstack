#!/usr/bin/env bun
/**
 * gstack-agent-map — render the ICM agent context map from repo-map.yml.
 *
 *   bun run ~/.claude/skills/gstack/bin/gstack-agent-map.ts [options]
 *
 * Options
 *   --config <path>   repo-map.yml to read (default: agent-work/repo-map.yml)
 *   --out <dir>       render into this directory instead of the canonical one.
 *                     An explicit operator override: a checked-in config cannot
 *                     choose a destination, because a mistyped one would overwrite
 *                     files outside the repository. The two filenames are fixed
 *                     either way.
 *   --check           render and compare, write nothing; exit 1 if the committed
 *                     output differs from what the config produces
 *   --stdout          print the Mermaid source and exit (no files written)
 *
 * The YAML is the source of truth; everything written here is a view of it.
 * Exit codes: 0 fine, 1 drift (--check) or a missing file, 2 invalid config.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  parseRepoMap,
  renderMermaid,
  renderMarkdown,
  RepoMapError,
  GENERATED_DIR,
  GENERATED_MERMAID,
  GENERATED_MARKDOWN,
} from '../lib/agent-map';
import { resolveOutputPlan, writeGeneratedFile, OutputPathError } from '../lib/agent-map-output';

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`gstack-agent-map: ${name} needs a value`);
    process.exit(2);
  }
  return value;
}

const configPath = path.resolve(flag('--config') ?? 'agent-work/repo-map.yml');
const checkOnly = argv.includes('--check');
const toStdout = argv.includes('--stdout');

if (!fs.existsSync(configPath)) {
  console.error(
    `gstack-agent-map: no config at ${configPath}\n` +
      `  Run /icm-repo-cartographer to scaffold the workspace, or pass --config <path>.`,
  );
  process.exit(1);
}

let rendered: { mermaid: string; markdown: string };
let outDir: string;
/** The repository being mapped: the directory that contains agent-work/. */
let repoRoot: string;
/** True when a person asked for somewhere else on the command line. */
const explicitOut = flag('--out');

try {
  const text = fs.readFileSync(configPath, 'utf-8');
  const map = parseRepoMap(text);
  const mermaid = renderMermaid(map);
  rendered = { mermaid, markdown: renderMarkdown(map, mermaid) };
  repoRoot = path.dirname(path.dirname(configPath));
  // The canonical location is fixed tool policy. The config has no say in it —
  // there is no field to read — so the only way to write elsewhere is an operator
  // typing --out at the moment of running.
  outDir = path.resolve(explicitOut ?? path.join(repoRoot, GENERATED_DIR));
} catch (err) {
  if (err instanceof RepoMapError) {
    // Actionable by construction: the message carries the field and the fix.
    console.error(`gstack-agent-map: invalid config\n  ${err.message}\n  File: ${configPath}`);
    process.exit(2);
  }
  throw err;
}

if (toStdout) {
  process.stdout.write(rendered.mermaid);
  process.exit(0);
}

/**
 * One boundary for both modes. resolveOutputPlan does the lexical containment
 * check AND walks every existing filesystem component below the repository root —
 * agent-work, the output directory, the target parents, the targets — rejecting a
 * symlink anywhere along the way with `lstat` and never resolving it.
 *
 * It runs BEFORE --check reads a file and before normal mode writes one, because
 * a symlinked target is as dangerous to read through as to write through: a check
 * that follows the link reports "matches" about a file somewhere else entirely.
 */
let plan: ReturnType<typeof resolveOutputPlan>;
try {
  plan = resolveOutputPlan({ root: repoRoot, outDir });
} catch (err) {
  if (err instanceof OutputPathError) {
    console.error(`gstack-agent-map: unsafe output path\n  ${err.message}\n  Config: ${configPath}`);
    process.exit(2);
  }
  throw err;
}

const targets: Array<[string, string]> = [
  [plan.targets[0].file, rendered.mermaid],
  [plan.targets[1].file, rendered.markdown],
];

if (checkOnly) {
  const drifted = targets.filter(([file, want]) => {
    if (!fs.existsSync(file)) return true;
    return fs.readFileSync(file, 'utf-8') !== want;
  });
  if (drifted.length > 0) {
    console.error(
      `gstack-agent-map: generated map is stale\n` +
        drifted.map(([f]) => `  ${path.relative(process.cwd(), f)}`).join('\n') +
        `\n  Regenerate: bun run bin/gstack-agent-map.ts --config ${path.relative(process.cwd(), configPath)}`,
    );
    process.exit(1);
  }
  console.log('gstack-agent-map: generated map matches the config');
  process.exit(0);
}

fs.mkdirSync(plan.outDir, { recursive: true });
for (const [file, content] of targets) {
  // Temp regular file inside the verified directory, then an atomic rename. The
  // rename replaces the directory entry itself, so even an entry that appeared
  // after validation is replaced rather than written through.
  writeGeneratedFile(file, content);
  console.log(`WROTE ${path.relative(process.cwd(), file)}`);
}
