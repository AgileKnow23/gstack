/**
 * Shared runner for the agent-map CLI in tests.
 *
 * Exists for two reasons. First, the sync-spawn tripwire: a child that blocks
 * forever wedges the whole shard, because bun's per-test timeout cannot fire
 * while a synchronous spawn is waiting. Routing every cartographer CLI call
 * through one helper means one call site carries the timeout instead of N, and
 * a future test cannot forget it.
 *
 * Second, the install-contract suite needs to invoke a COPY of the CLI sitting
 * in a materialized runtime root, not the one in this checkout — so the binary
 * under test is a parameter, not a constant.
 */

import * as path from 'node:path';

/** Generous enough for a cold bun start on a loaded CI box, finite on purpose. */
export const CLI_TIMEOUT_MS = 60_000;

export interface CliResult {
  code: number | null;
  out: string;
  err: string;
  /** True when the failure is a module/package resolution error rather than a config one. */
  dependencyError: boolean;
}

/**
 * Resolution failures are phrased differently per runtime and per version, and
 * the phrasing is not something this repo controls. Bun 1.3 says
 * `ENOENT while resolving package 'yaml' from …`; Node says `Cannot find package`
 * or `ERR_MODULE_NOT_FOUND`. Match all of them — a missed shape would let a real
 * install break slip past as if it were a config error.
 */
const DEPENDENCY_ERROR =
  /Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Could not resolve|while resolving package/i;

/**
 * Run an agent-map CLI entry point.
 *
 * @param cli  absolute path to the CLI (`.ts` source in this repo, or the bundled
 *             `.js` as delivered by setup into a runtime root)
 * @param args CLI arguments
 * @param cwd  working directory — for the install contract this is a target repo
 *             that deliberately has no node_modules of its own
 */
export function runAgentMapCli(cli: string, args: string[], cwd: string): CliResult {
  const proc = Bun.spawnSync(['bun', 'run', path.resolve(cli), ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: CLI_TIMEOUT_MS,
  });
  const out = new TextDecoder().decode(proc.stdout);
  const err = new TextDecoder().decode(proc.stderr);
  return { code: proc.exitCode, out, err, dependencyError: DEPENDENCY_ERROR.test(err) };
}
