import Foundation

struct PreflightReq: Identifiable {
    var id: String { (env ?? "") + item }
    let item: String
    let status: String   // ready | missing | unclear
    let note: String
    let env: String?     // exact env var name when the requirement is an env var/secret
}

struct GateDecision: Identifiable {
    var id: String { question }
    let question: String
    let defaultAnswer: String?   // "yes" | "no" | nil (planner's suggestion)
    var savedAnswer: String? = nil   // previously-submitted answer from <run>.decisions.json
}

struct Gate: Identifiable {
    let id: String
    let gate: String        // "preview" | "review"
    let summary: String
    let repo: String
    var preflight: [PreflightReq] = []
    var decisions: [GateDecision] = []
}

struct QueueItem: Identifiable {
    let id: String
    let title: String
    let type: String
    // Scheduling metadata, parsed from the same nyx.md tags the dispatcher's
    // task-reader reads. A task carries [slot:] XOR [every:], or neither
    // (standing). Pending decompose/queue actions are always standing/normal.
    var priority: String = "normal"
    var slot: Int? = nil            // [slot: N] — fires daily at this 5-min slot
    var everyStepSlots: Int? = nil  // [every: K] — cadence step expressed in slots
    var detail: String = ""         // one-sentence description (body, sans tags)

    // Standing iff it has no scheduling tag. Slotted/cadence tasks render on the
    // week calendar; standing tasks render in the right-hand list.
    var isStanding: Bool { slot == nil && everyStepSlots == nil }
}

struct AuditRow: Identifiable {
    let id = UUID()
    let at: String
    let event: String
    let detail: String
    let subjectId: String?   // taskId/runId extracted from payload, or nil for system rows
}

struct NyxState {
    var gates: [Gate] = []
    var queue: [QueueItem] = []
    var audit: [AuditRow] = []
    var lastTick: String = "—"
    var healthy: Bool = false
}
