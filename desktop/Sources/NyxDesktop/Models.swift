import Foundation

struct Gate: Identifiable {
    let id: String
    let gate: String        // "preview" | "review"
    let summary: String
    let repo: String
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
}

struct NyxState {
    var gates: [Gate] = []
    var queue: [QueueItem] = []
    var audit: [AuditRow] = []
    var lastTick: String = "—"
    var healthy: Bool = false
}
