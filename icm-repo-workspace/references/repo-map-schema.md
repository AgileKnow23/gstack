# repo-map.yml — schema reference

One reusable engine, one project-specific configuration file. `/icm-repo-workspace`
is the engine and is byte-identical in every repository. `agent-work/repo-map.yml`
is the configuration, and it is the only file in the scaffold that carries project
facts.

Read this when filling the file in, or when deciding whether something belongs here
at all. The test: if a sentence could go stale independently of the thing it
describes, it belongs in the document it points at, not here.

## Top-level keys

| Key | Required | Shape | Holds |
|---|---|---|---|
| `schema` | yes | string | Pin, currently `icm-repo-workspace/v1`. Lets the engine change without silently misreading old files. |
| `repo` | yes | map | Identity: `name`, `form`, `entry`. |
| `sources_of_truth` | yes | list | Ordered catalog of documents that already exist. |
| `domains` | yes | list | The parts of the repo that can be reasoned about separately. |
| `commands` | yes | map | The relevant command per intent. |
| `gates` | yes | list | Human gates. Always contains at least `deploy`. |
| `risk_markers` | yes | map | What escalates routing. Four fixed keys. |
| `routing_overrides` | no | list | Per-repo deviations, each with a reason. |

## `repo`

- `name` — the repository name.
- `form` — `context-map`, `pipeline`, or `composed`. See [classification.md](classification.md).
- `entry` — the entry file, normally `AGENTS.md`. Recorded so tooling does not guess.

There is deliberately no `summary` here. "What is this repo and what ships out of
it" must be answerable from the entry file without opening anything else, so that
sentence lives in `AGENTS.md` and only there. A summary in both places is the first
fact to drift, and it drifts silently because nobody diffs a sentence.

## `sources_of_truth`

Ordered; the first entry is where a cold agent starts. Each entry:

- `path` — a document **that exists today**. Never list an aspirational one.
- `holds` — the question this document is the answer to. Not a summary of it.
- `read_when` — the trigger that makes it worth the tokens. This is what keeps an
  agent from loading the whole catalog on every task.

## `domains`

A domain is a part of the repo that can be reasoned about on its own. Two domains
touched by one change is the definition of cross-domain, which is what the planning
route keys off.

- `name` — short, stable, the word the team actually uses.
- `paths` — path prefixes. Prefixes, not globs: cheap to match, hard to get wrong.
- `doc` — optional. Omit rather than invent.
- `risk` — any of the four `risk_markers` keys that this domain carries by default.

Fewer, truer domains beat many speculative ones. Three real domains is a working
map; twelve imagined ones is a diagram.

## `commands`

`install`, `build`, `test`, `lint`, `e2e`, `dev_url`. Omit a key rather than guess —
a wrong command costs more than a missing one, because a missing one asks and a
wrong one fails confusingly.

`dev_url` is load-bearing for routing: browser QA runs only when a runnable URL
exists. `null` is the correct value when nothing runnable exists, and it makes the
skip explicit rather than accidental.

## `gates`

Each gate: `id`, `when`, `requires`, `self_clearable`.

The `deploy` gate is mandatory and `self_clearable: false`. Deployment requires
explicit user authorization every time; approval never carries forward. Add gates
for whatever else this project treats as one-way — migrations against a shared
database, anything that reaches a customer, anything that costs money.

## `risk_markers`

Four fixed keys: `tenant_isolation`, `auth`, `billing`, `externally_reachable`.
Each maps to a list of path fragments or literals that mark a change as carrying
that risk.

The key set is fixed on purpose. An open set drifts into a taxonomy nobody
maintains, and routing then depends on whether the author remembered a label. An
empty list is a real answer: it says this repository has no such surface.

## `routing_overrides`

Optional. Each override names `when`, the `skills` it changes the route to, and a
`reason`. An override without a reason is ritual wearing the costume of judgment.

## What does not belong here

Architecture notes, terminology, coding standards, runbooks, history. All of it
already lives somewhere in the repo; add a `sources_of_truth` entry pointing at it.
A fact stored twice will eventually disagree with itself, and then neither copy can
be trusted.
