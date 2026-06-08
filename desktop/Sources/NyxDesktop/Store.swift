import Foundation
import SwiftUI

@MainActor
final class Store: ObservableObject {
    @Published var state = NyxState()
    @Published var systemName = Layout.systemName
    @Published var lastDispatch = ""
    @Published var lastDecision = ""
    @Published var ticking = false
    @Published var nextTickCountdown = "—"
    @Published var updateAvailable = false
    @Published var updateLocal = ""
    @Published var updateRemote = ""
    @Published var updating = false

    private var timer: Timer?
    private var countdownTimer: Timer?
    private var lastUpdateCheckAt: Date?

    func start() {
        refresh()
        checkForUpdate()
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
        // Database.* and QueueFile.load() open the WAL SQLite DB, step rows, and read
        // brief files from disk — synchronous I/O that under dispatcher-tick contention
        // can stall. Run it off the main actor and hand the value-type result back for
        // assignment so the UI thread never blocks on file/DB I/O.
        Task.detached(priority: .utility) {
            var s = NyxState()
            s.gates = Database.loadGates()
            s.queue = Database.loadPendingQueue() + QueueFile.load()
            s.audit = Database.loadAudit()
            if let t = Database.lastTick() { s.lastTick = t; s.healthy = true }
            let result = s
            await MainActor.run { [weak self] in self?.state = result }
        }
        checkForUpdate()
    }

    // Run a script with brew bins on PATH (a Finder-launched .app has a minimal
    // PATH), capturing stdout + exit code. Off the main actor; small output only.
    nonisolated private static func runCapture(_ url: URL, args: [String] = []) -> (out: String, code: Int32) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [url.path] + args
        var env = ProcessInfo.processInfo.environment
        let brewBins = "/opt/homebrew/bin:/usr/local/bin"
        env["PATH"] = env["PATH"].map { "\(brewBins):\($0)" } ?? "\(brewBins):/usr/bin:/bin"
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        do { try p.run() } catch { return ("", -1) }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (String(data: data, encoding: .utf8) ?? "", p.terminationStatus)
    }

    // Compare installed Core against origin/main; throttled to once an hour so the
    // 15s refresh timer doesn't hit the network every tick.
    func checkForUpdate(force: Bool = false) {
        if !force, let last = lastUpdateCheckAt, Date().timeIntervalSince(last) < 3600 { return }
        let script = Layout.updateCheckScript
        guard FileManager.default.fileExists(atPath: script.path) else { return }
        lastUpdateCheckAt = Date()
        Task.detached(priority: .utility) {
            let r = Store.runCapture(script)
            let parts = r.out.split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init)
            let status = parts.first ?? "unknown"
            await MainActor.run { [weak self] in
                guard let self else { return }
                if status == "update-available", parts.count >= 3 {
                    self.updateAvailable = true
                    self.updateLocal = parts[1]
                    self.updateRemote = parts[2]
                } else {
                    self.updateAvailable = false
                }
            }
        }
    }

    // nyx update self-detaches the Homebrew reinstall and returns quickly; the
    // daemon picks up new code via the opt symlink on its next tick.
    func applyUpdate() {
        let script = Layout.updateScript
        guard !updating, FileManager.default.fileExists(atPath: script.path) else { return }
        updating = true
        Task.detached(priority: .utility) {
            _ = Store.runCapture(script)
            await MainActor.run { [weak self] in
                self?.updating = false
                self?.updateAvailable = false
            }
        }
    }

    func decide(_ runId: String, _ decision: String, note: String?) {
        var params = ["runId": runId, "decision": decision]
        if let note, !note.isEmpty { params["note"] = note }
        // The write can fail (SQLITE_BUSY past the busy_timeout while the dispatcher
        // holds the WAL write lock). Don't pretend success: a dropped decision must
        // stay visible and retryable. Only fire the tick once the row is actually
        // recorded; refresh either way so the gate card persists (no operator_decision
        // row was written, so loadGates() keeps showing it).
        let ok = Database.enqueueAction("pipeline_decision", params: params)
        if ok {
            lastDecision = ""
            runTick()
        } else {
            lastDecision = "Decision not recorded (DB busy). Tap again to retry."
        }
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
