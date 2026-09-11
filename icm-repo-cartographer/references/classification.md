# Classifying a repository: context map, pipeline, or composed

Read this at Phase 2, after the inspection and before proposing anything. The form
decides how `contexts:` is written and how status is answered. It does not change
the scaffold's file list — the adapter is the same eight files either way.

Classify from what the repository already does, not from what would be tidy.

## Context map

**The repo is a graph.** Parts relate to each other, but no fixed order runs
through them. Work enters at whichever node the request names.

Signals:
- Feature folders, bounded contexts, packages, or services sitting side by side
- No numbered stages, no "step 1 / step 2" in the docs
- "Where does this change go?" is answered by *which area*, not *how far along*

How it lands in `repo-map.yml`: `contexts:` are the nodes, and `depends_on` draws the edges the map renders. Expect several, each with
its own `paths:` and its own `sources_of_truth:` ids. Status is a git question, not a folder
scan.

## Pipeline

**The repo runs a known sequence** and something leaves at the end. The same shape
runs again with different input.

Signals:
- Numbered directories, or stages named for their position in a run
- An `output/`, `dist/`, `build/`, or `reports/` folder that accumulates per run
- Documentation that reads as an order of operations
- A human checkpoint between steps that everyone knows about and nobody wrote down

How it lands: `contexts:` are the stages, in order. The human checkpoints between
stages are `gates:` — that is usually where the most valuable gate in the whole
file comes from, because it already exists as a habit.

## Composed

**A map whose contexts carry small pipelines.** This is what most real product
repositories are, and guessing "composed" when torn is usually right.

Signals:
- Feature areas that sit side by side (map), and at least one of them has its own
  ordered flow — a migration path, a generation step, a review sequence
- One area's output is another's input, but only sometimes

How it lands: `contexts:` are the map nodes. A context that carries an internal order
says so in the document its `sources_of_truth:` names; the top-level file does not
describe the inside of a context.
Each level keeps its own small catalog and links down without describing what is
below it.

## When the classification is contested

Ask the owner one question: *what is the repeating unit of work here* — an area
someone owns, or a run that produces something? Areas mean map. Runs mean pipeline.
Both, honestly answered, mean composed.

Do not split the difference by inventing a fourth form. The form is a lens for
writing `contexts:` well, not a label anyone will defend later.

## What the form does not decide

- The scaffold's file list. Always the same eight files, six authored and two generated.
- The routing rules. Those key off risk, not form.
- Folder layout of the repository itself. This skill adapts to the repo; it never
  reorganizes it. Restructuring a repository into ICM shape is a different job, done
  deliberately, with its own approval.
