/**
 * agent-map-output — the one place that decides where generated files may live.
 *
 * Lexical containment is not enough. `path.resolve` and `path.relative` work on
 * strings, so when a checked-out repository already contains
 * `agent-work/generated/agent-map.mmd` as a symlink pointing anywhere, the path
 * still classifies as inside the output directory and the write follows the link.
 * A repository could therefore redirect generation at any user-writable file.
 *
 * So this module answers a different question: is every real filesystem
 * component on the way to each target an ordinary directory or file? It answers
 * it with `lstat` alone, which reports the link itself rather than what the link
 * points at. **Nothing here ever resolves a suspicious component** — no `stat`,
 * no `realpath`, no `readlink`. Following a link to judge whether following it is
 * safe is the bug, not the check.
 *
 * The walk starts strictly BELOW the root, deliberately. A symlink above the
 * repository is the user's own filesystem layout — a symlinked home directory, or
 * macOS resolving `/tmp` to `/private/tmp` — and rejecting that would refuse
 * ordinary machines while protecting nobody.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Carries the configured field and the offending path so the message can be acted on. */
export class OutputPathError extends Error {
  constructor(
    readonly field: string,
    readonly offendingPath: string,
    message: string,
  ) {
    super(message);
    this.name = 'OutputPathError';
  }
}

export interface OutputTarget {
  /** `mermaid` or `markdown` — the key in generated_map. */
  key: string;
  /** The dotted field a user would edit, e.g. `generated_map.mermaid`. */
  field: string;
  /** Absolute path of the file to produce. */
  file: string;
}

export interface OutputPlan {
  /** Absolute, verified output directory. */
  outDir: string;
  targets: OutputTarget[];
}

export interface ResolveOptions {
  /** Repository/config root. Components at or above this are not judged. */
  root: string;
  /** Output directory as configured or passed via --out; may be relative. */
  outDir: string;
  /** Bare filename for the Mermaid artifact. */
  mermaid: string;
  /** Bare filename for the Markdown artifact. */
  markdown: string;
}

/** Ancestors of `target` that sit strictly below `root`, outermost first, then the target. */
function componentsBelow(root: string, target: string): string[] {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);

  const rel = path.relative(rootResolved, targetResolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    // The target is not under the root — judge its whole ancestor chain instead,
    // stopping at the filesystem root. This happens only with an explicit --out
    // somewhere else, and in that case there is no "user's layout" to excuse.
    const chain: string[] = [];
    let current = targetResolved;
    for (;;) {
      chain.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    // Drop the filesystem root itself: on macOS `/` is fine, and on Windows the
    // drive root cannot be a link.
    return chain.slice(1);
  }

  const segments = rel.split(path.sep).filter((s) => s !== '');
  const chain: string[] = [];
  let current = rootResolved;
  for (const segment of segments) {
    current = path.join(current, segment);
    chain.push(current);
  }
  return chain;
}

/**
 * Reject a symlink at any existing component of `target` below `root`.
 *
 * Non-existent components are fine — they are what `mkdir -p` will create. Only
 * what is already on disk can lie about where it leads.
 */
export function assertNoSymlinkOnPath(root: string, target: string, field: string): void {
  for (const component of componentsBelow(root, target)) {
    let info: fs.Stats;
    try {
      // lstat, never stat: this reports the link, not the destination. Using stat
      // here would resolve the very thing being judged.
      info = fs.lstatSync(component);
    } catch {
      continue; // does not exist yet
    }
    if (info.isSymbolicLink()) {
      throw new OutputPathError(
        field,
        component,
        `refusing to use a symlinked path component\n  ${component}\n` +
          `  This component is a symbolic link, and generation would read or write through it to ` +
          `somewhere outside the output directory. Replace it with a real directory or file, or point ` +
          `${field} somewhere that is not linked. The link target was deliberately not resolved.`,
      );
    }
  }
}

/**
 * Resolve and fully validate the output plan.
 *
 * Called before `--check` reads anything and before normal mode writes anything,
 * so both paths get the same boundary. Throws OutputPathError; the caller turns
 * that into an exit code and a message.
 */
export function resolveOutputPlan(opts: ResolveOptions): OutputPlan {
  const outDir = path.resolve(opts.outDir);

  const targets: OutputTarget[] = [
    { key: 'mermaid', field: 'generated_map.mermaid', file: path.join(outDir, opts.mermaid) },
    { key: 'markdown', field: 'generated_map.markdown', file: path.join(outDir, opts.markdown) },
  ];

  // 1. Lexical containment — cheap, and catches the configured-name cases.
  for (const target of targets) {
    const rel = path.relative(outDir, path.resolve(target.file));
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new OutputPathError(
        target.field,
        target.file,
        `refusing to write outside the output directory\n  ${target.file}\n` +
          `  Output directory: ${outDir}\n  Every generated file must land inside it.`,
      );
    }
  }

  // 2. Filesystem reality — every existing component from below the root down
  //    through agent-work, the output directory, the target parents and the
  //    targets themselves. The output directory is covered because it is an
  //    ancestor of both targets.
  for (const target of targets) {
    assertNoSymlinkOnPath(opts.root, target.file, target.field);
  }

  return { outDir, targets };
}

/**
 * Write `content` to `file` without ever following a link at the destination.
 *
 * Renders to a temporary regular file inside the already-verified directory and
 * then renames it into place. `wx` fails rather than truncating if the temporary
 * name somehow exists, and `rename` replaces the entry itself — so even a link
 * that appeared between validation and write is replaced rather than followed.
 */
export function writeGeneratedFile(file: string, content: string): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`);

  let handle: number | undefined;
  try {
    handle = fs.openSync(tmp, 'wx'); // exclusive create; never truncates an existing entry
    fs.writeFileSync(handle, content);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }

  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the rename failure is what matters */
    }
    throw err;
  }
}
