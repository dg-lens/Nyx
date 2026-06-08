# T5 — Scaffold (forward-looking architecture proposals)

Tier 5 of the doc system: *what the system MIGHT become* — in-flight architecture
captured with rationale + shape + migration order so decisions aren't re-litigated
mid-task. On-demand only. Repo-tracked (here, `scaffold/`) so every instance + agent
sees the same proposals.

**Consult before** scoping a refactor or proposing a new structure — a proposal here
may already specify the shape. Composer alignment passes MUST check this index for any
proposal touching the affected modules.

Admission test: a change is *proposed but not yet built*. Once implemented, the fact
graduates to a tier doc (T2/T3) and its row here is struck.

| Proposal | Scope | Status |
|---|---|---|
| [`arachne-shared-backbone.md`](arachne-shared-backbone.md) | Arachne as the single hub every Nyx/AI system talks through (memory + gate relay + coordination + presence planes); integrates via host plugins, Core unchanged | engines built; deploy + adapters pending |

> Note: the prompt-to-product **pipeline** design has graduated — it's implemented and
> documented at [T3 `apps/dispatcher/src/pipeline/CLAUDE.md`]. Older docs that cite
> `[T5 scaffold/prompt-to-product-pipeline.md]` should point there.
