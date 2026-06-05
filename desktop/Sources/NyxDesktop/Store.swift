import Foundation
import SwiftUI

@MainActor
final class Store: ObservableObject {
    @Published var state = NyxState()
    @Published var systemName = Layout.systemName
    @Published var lastDispatch = ""
    @Published var ticking = false

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
        guard !ticking, FileManager.default.fileExists(atPath: script.path) else { return }
        ticking = true
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [script.path, "--no-build"]
        // A Finder-launched .app inherits a minimal PATH (no Homebrew), so the
        // tick script can't find node/claude. Prepend the common brew bin dirs.
        var env = ProcessInfo.processInfo.environment
        let brewBins = "/opt/homebrew/bin:/usr/local/bin"
        if let path = env["PATH"], !path.isEmpty {
            env["PATH"] = "\(brewBins):\(path)"
        } else {
            env["PATH"] = "\(brewBins):/usr/bin:/bin"
        }
        p.environment = env
        p.terminationHandler = { _ in
            DispatchQueue.main.async { [weak self] in
                self?.ticking = false
                self?.refresh()
            }
        }
        do { try p.run() } catch { ticking = false }
    }
}
