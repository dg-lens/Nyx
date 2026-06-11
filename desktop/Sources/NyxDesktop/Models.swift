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
