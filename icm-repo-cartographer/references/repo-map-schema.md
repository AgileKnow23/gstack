# repo-map.yml — schema reference

One reusable engine, one project-specific configuration file.
`/icm-repo-cartographer` is the engine and is identical in every repository.
`agent-work/repo-map.yml` is the configuration, and it is the only file in the
scaffold that carries project facts.

It is also the **canonical source of truth**. `agent-work/generated/` is rendered
from it. When they disagree, this file wins and the map is stale.

Read this when filling the file in, or when deciding whether something belongs here
at all. The test: if a sentence could go stale independently of the thing it
describes, it belongs in the document it points at, not here.

Validation lives in `lib/agent-map.ts` and runs on every render. Every failure
names the field, what was found, and the edit that fixes it.

## Top-level keys

| Key | Required | Shape | Holds |
|---|---|---|---|
| `schema` | yes | string | Pin, currently `icm-repo-cartographer/v1`. Lets the engine change without silently misreading old files. |
| `project` | yes | map | Identity and stack. |
| `sources_of_truth` | yes | list | Ordered catalog of documents that already exist, each with an `id`. |
| `contexts` | yes | list | Bounded contexts / major modules. |
| `boundaries` | yes | map | `allowed` and `protected` paths. |
| `commands` | yes | map | The relevant command per intent. |
| `task_classes` | yes | list | The canonical routing table. |
| `gates` | yes | list | Human gates. Always contains `deploy`. |
| `risk_markers` | yes | map | What escalates routing. Four fixed keys. |
| `generated_map` | yes | map | Where the rendered view goes, and the assertion that it is not authoritative. |

## `project`

`name`, `form` (`context-map` / `pipeline` / `composed` — see
[classification.md](classification.md)), `entry` (normally `AGENTS.md`), and
`stack` (`languages`, `runtime`, `frameworks`, `datastore`, `hosting`).

There is deliberately **no `summary`**, and the validator rejects one. "What is this
repo and what ships out of it" must be answerable from the entry file without
opening anything else, so that sentence lives in `AGENTS.md` and only there. A
summary in both places is the first fact to drift, and it drifts silently because
nobody diffs a sentence.

## `sources_of_truth`

Ordered; the first entry is where a cold agent starts. Each entry:

- `id` — short and stable. Contexts reference documents by id, so a rename here is
  a rename everywhere, and a dangling id fails the render rather than rotting.
- `path` — a document **that exists today**. Never list an aspirational one.
- `holds` — the question this document is the answer to. Not a summary of it.
- `read_when` — the trigger that makes it worth the tokens. This is what keeps an
  agent from loading the whole catalog on every task.

## `contexts`

A context is a part of the repo that can be reasoned about on its own. Two contexts
touched by one change is the definition of cross-context, which is what the planning
route keys off.

- `name` — short, stable, the word the team actually uses.
- `purpose` — one line: what this part of the repo is responsible for.
- `paths` — path prefixes. Prefixes, not globs: cheap to match, hard to get wrong.
  At least one, or the context cannot be routed to.
- `sources_of_truth` — ids from the top-level list. Unknown ids fail the render.
- `depends_on` — other context names. **These become the map's edges**, so record
  the dependencies that are real rather than the ones that would look tidy. A
  self-dependency fails.
- `risk` — any of the four `risk_markers` keys this context carries by default.

Fewer, truer contexts beat many speculative ones. Three real contexts is a working
map; twelve imagined ones is a diagram.

## `boundaries`

- `allowed` — path prefixes an agent may change under the normal routing rules.
- `protected` — a list of `{paths, why, gate}`. The `why` is what breaks if this
  changes without review; the `gate` must be a known gate id. A protected path
  carries its gate **on top of** whatever the task class said.

## `commands`

`build`, `test`, `typecheck`, `lint`, `docs`, `deploy`, `dev_url`. Use `null` for a
command this repository does not have — a wrong command costs more than a missing
one, because a missing one asks and a wrong one fails confusingly.

`dev_url` is load-bearing for routing: browser QA runs only when a runnable URL
exists, and `null` makes the skip explicit rather than accidental.

## `task_classes`

The single home for "which skill does this change earn". Each entry: `id`, `when`,
`skill` (a `/`-prefixed skill, or `null`), `gate` (a known gate id, or `null`), and
an optional `note`.

At least one class must carry `skill: null`, and the validator enforces it. A
routing table where every change earns a workflow is ceremony, not routing.

The prose in `_system/skill-routing.md` explains how to apply this table and
deliberately does not restate it.

## `gates`

Each gate: `id`, `when`, `requires`, `authority`.

**There is deliberately no `self_clearable` field, and declaring one fails the
parse.** Every gate is non-self-clearable by construction rather than by
configuration. The alternative — a boolean a project can flip — means a gate can
guard a boundary while the canonical config says an agent may clear it, which is
an approval boundary that exists only on paper.

The test for whether something belongs here: **if it can clear itself
automatically, it is a check, not a gate.** Checks belong in `commands:` or in a
task class; `gates:` is for the moments a person decides.

The `deploy` gate is mandatory, with `authority: user`.
Merging and deploying require explicit user authorization every time; approval never
carries forward. Add gates for whatever else this project treats as one-way —
migrations against a shared database, anything that reaches a customer, anything
that costs money.

## `risk_markers`

Four fixed keys: `auth`, `tenant_isolation`, `billing`, `externally_reachable`.
Each maps to path fragments or literals that mark a change as carrying that risk.

The key set is fixed on purpose. An open set drifts into a taxonomy nobody
maintains, and routing then depends on whether the author remembered a label. An
empty list is a real answer: it says this repository has no such surface.

## `generated_map`

`output_dir`, `mermaid`, `markdown`, `direction` (a Mermaid direction), and
`source_of_truth`, which **must be `false`** — the validator refuses anything else.
That field is not decoration: it is the assertion, in the config itself, that the
rendered map is a view and never the thing being viewed.

## What does not belong here

Architecture notes, terminology, coding standards, runbooks, history. All of it
already lives somewhere in the repo; add a `sources_of_truth` entry pointing at it.
A fact stored twice will eventually disagree with itself, and then neither copy can
be trusted.
