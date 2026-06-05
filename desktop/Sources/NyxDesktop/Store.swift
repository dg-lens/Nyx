import Foundation
import SwiftUI

@MainActor
final class Store: ObservableObject {
    @Published var state = NyxState()
    @Published var systemName = Layout.systemName
    @Published var lastDispatch = ""

    private var timer: Timer?

    func start() {
        refresh()
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh() {
        var s = NyxState()
        s.gates = Database.loadGates()
        s.queue = QueueFile.load()
        s.audit = Database.loadAudit()
        if let t = Database.lastTick() { s.lastTick = t; s.healthy = true }
        state = s
    }

    func decide(_ runId: String, _ decision: String, note: String?) {
        var params = ["runId": runId, "decision": decision]
        if let note, !note.isEmpty { params["note"] = note }
        Database.enqueueAction("pipeline_decision", params: params)
        runTick()
        refresh()
    }

    func dispatch(text: String, type: String, repo: String?) {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        var params = ["text": text, "type": type]
        if let repo, !repo.isEmpty { params["repo"] = repo }
        let ok = Database.enqueueAction("queue_task", params: params)
        lastDispatch = ok ? "Queued → \(systemName).md (applies next tick)" : "Failed to enqueue"
        refresh()
    }

    func runTick() {
        let script = Layout.tickScript
        guard FileManager.default.fileExists(atPath: script.path) else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [script.path]
        try? p.run()
    }
}
