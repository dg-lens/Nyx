import Foundation
import SwiftUI

@MainActor
final class Store: ObservableObject {
    @Published var state = NyxState()
    @Published var systemName = Layout.systemName
    @Published var lastDispatch = ""
    @Published var ticking = false
    @Published var nextTickCountdown = "—"

    private var timer: Timer?
    private var countdownTimer: Timer?

    func start() {
        refresh()
        updateCountdown()
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        countdownTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.updateCountdown() }
        }
    }

    // Ticks fire on the wall-clock 5-minute grid (:00, :05, …); count down to the
    // next boundary. Reflects the daemon schedule once `brew services start`.
    func updateCountdown() {
        let c = Calendar.current.dateComponents([.minute, .second], from: Date())
        let secsInto = ((c.minute ?? 0) % 5) * 60 + (c.second ?? 0)
        let remaining = max(0, 300 - secsInto)
        nextTickCountdown = String(format: "%d:%02d", remaining / 60, remaining % 60)
    }

    func refresh() {
        systemName = Layout.systemName
        var s = NyxState()
        s.gates = Database.loadGates()
        s.queue = Database.loadPendingQueue() + QueueFile.load()
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

    func dispatch(text: String, type: String, model: String, priority: String, repo: String?, schedule: String) {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        var params = ["text": text, "type": type, "model": model, "priority": priority]
        if let repo, !repo.isEmpty { params["repo"] = repo }
        if !schedule.isEmpty { params["schedule"] = schedule }
        // decompose_task: the dispatcher runs a sonnet claude -p pass that turns
        // this plain-language request into one or more fully-tagged queue tasks.
        let ok = Database.enqueueAction("decompose_task", params: params)
        lastDispatch = ok ? "Decomposing via sonnet… tasks will appear in the queue." : "Failed to enqueue"
        refresh()
        if ok { runTick() }
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
