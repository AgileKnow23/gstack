#!/usr/bin/env bun
/**
 * gstack-agent-map — render the ICM agent context map from repo-map.yml.
 *
 *   bun run ~/.claude/skills/gstack/bin/gstack-agent-map.ts [options]
 *
 * Options
 *   --config <path>   repo-map.yml to read (default: agent-work/repo-map.yml)
 *   --out <dir>       output directory (default: generated_map.output_dir)
 *   --check           render and compare, write nothing; exit 1 if the committed
 *                     output differs from what the config produces
 *   --stdout          print the Mermaid source and exit (no files written)
 *
 * The YAML is the source of truth; everything written here is a view of it.
 * Exit codes: 0 fine, 1 drift (--check) or a missing file, 2 invalid config.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseRepoMap, renderMermaid, renderMarkdown, RepoMapError } from '../lib/agent-map';

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
let mermaidName: string;
let markdownName: string;

try {
  const text = fs.readFileSync(configPath, 'utf-8');
  const map = parseRepoMap(text);
  const mermaid = renderMermaid(map);
  rendered = { mermaid, markdown: renderMarkdown(map, mermaid) };
  outDir = path.resolve(flag('--out') ?? path.join(path.dirname(path.dirname(configPath)), map.generated_map.output_dir));
  mermaidName = map.generated_map.mermaid;
  markdownName = map.generated_map.markdown;
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
 * Output confinement, part two. parseRepoMap already refuses a filename that is
 * a path, but --out is a flag and output_dir is config, so the only claim worth
 * making is about the RESOLVED targets: every file this tool writes lands inside
 * the resolved output directory. Checked here, before a single byte is written,
 * because the failure mode is overwriting a file nobody asked us to touch.
 */
function insideOutDir(target: string): boolean {
  const root = path.resolve(outDir);
  const resolved = path.resolve(target);
  const rel = path.relative(root, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const targets: Array<[string, string]> = [
  [path.join(outDir, mermaidName), rendered.mermaid],
  [path.join(outDir, markdownName), rendered.markdown],
];

const escaping = targets.filter(([file]) => !insideOutDir(file));
if (escaping.length > 0) {
  console.error(
    `gstack-agent-map: refusing to write outside the output directory\n` +
      escaping.map(([f]) => `  ${f}`).join('\n') +
      `\n  Output directory: ${path.resolve(outDir)}\n` +
      `  Every generated file must land inside it. Fix generated_map in ${configPath}, or pass a --out inside it.`,
  );
  process.exit(2);
}

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

fs.mkdirSync(outDir, { recursive: true });
for (const [file, content] of targets) {
  fs.writeFileSync(file, content);
  console.log(`WROTE ${path.relative(process.cwd(), file)}`);
}
