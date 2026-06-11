import SwiftUI
import AppKit

// Interactive widget actions: the closed allowlist behind manifest `actions`.
//
// Manifests (operator-droppable, mesh-shareable JSON) only ever REFERENCE named
// capabilities — {kind, target} pairs. Everything executable lives HERE, in
// code-defined registry entries, so a hostile widgets/*.json can do nothing the
// code didn't already allow:
//
//   * nav    — switch the app to a tab/dashboard, via ActionRouter (no exec).
//   * reveal — NSWorkspace "reveal in Finder" of a path VALIDATED (realpath,
//              no ../ escape) against operator-configured allowed roots.
//   * op     — a NAMED Nyx operation reusing the EXISTING Store/Database paths
//              (tick, refresh, resume, pipelineDecision) — no new Process spawns.
//
// The operator tunes exposure (never extends behavior) via
// $NYX_DATA_DIR/widget-actions.json — see WidgetActionsConfig below. Resolution
// runs in DashboardStore on the refresh cadence (file IO lives there, never in a
// view body); WidgetView reads the cached ResolvedWidgetAction list.

// MARK: - Navigation plumbing

// In-app navigation targets a nav action can reference. `dashboard` selects a
// dashboard by id within the Dashboards tab.
enum NavTarget: Hashable {
    case monitor
    case apps
    case tasks
    case dashboard(String)
}

// Bridges widget buttons to RootView's tab @State. RootView owns the selection;
// it creates this router and injects it as an environmentObject (matching the
// Store injection idiom), then consumes published nav requests. The request
// auto-clears on the next runloop turn so a late subscriber never replays a
// stale navigation.
@MainActor
final class ActionRouter: ObservableObject {
    @Published var navTarget: NavTarget?

    func navigate(_ target: NavTarget) {
        navTarget = target
        DispatchQueue.main.async { [weak self] in self?.navTarget = nil }
    }
}

// MARK: - Resolved actions (what WidgetView renders)

// A registry-validated operation a button can execute. Produced at resolve time;
// the view just dispatches it via WidgetActionRegistry.perform. `reveal` carries
// the already-validated REAL path (symlinks resolved), so a symlink swapped
// after validation can't redirect the reveal.
enum WidgetOp: Hashable {
    case nav(NavTarget)
    case reveal(URL)
    case tick
    case refresh
    case resume(String)
    case pipelineDecision(runId: String, decision: String)
}

// One manifest action after registry+config resolution. `op == nil` means the
// button renders DISABLED with `help` explaining why (unknown action, operator-
// disabled, refused path) — a manifest request is always visible, never silently
// executable.
struct ResolvedWidgetAction: Identifiable, Hashable {
    let id: String
    let label: String
    let icon: String?
    let help: String
    let op: WidgetOp?
}

// MARK: - Operator allowlist config

// $NYX_DATA_DIR/widget-actions.json — the operator's exposure knob. It can only
// NARROW or relabel what the code registry defines: `enabledOps` is intersected
// with the registry's known ids (unknown ids ignored, never executed), and
// `overrides` may relabel/re-icon known ids only. `revealRoots` sets where
// reveal targets may resolve. Missing file = sensible defaults (all registry ops
// enabled, default roots); corrupt file = defaults + a stderr note, never a
// crash and never anything newly executable (DashboardStore's corrupt-safe
// posture). The app never writes this file.
struct WidgetActionsConfig {
    struct Override: Decodable { let label: String?; let icon: String? }

    var enabledOps: Set<String>
    var revealRoots: [String]
    var overrides: [String: Override]

    static var configPath: URL { Layout.dataDir.appendingPathComponent("widget-actions.json") }

    // Default roots: outputs, ledger, the apps dir, and pipeline deliverables
    // (Data/projects) — the known output surfaces, nothing else.
    static var defaults: WidgetActionsConfig {
        WidgetActionsConfig(
            enabledOps: WidgetActionRegistry.opIds,
            revealRoots: [
                Layout.dataDir.appendingPathComponent("outputs").path,
                Layout.dataDir.appendingPathComponent("ledger").path,
                Layout.appsDir.path,
                Layout.dataDir.appendingPathComponent("projects").path,
            ],
            overrides: [:])
    }

    private struct Raw: Decodable {
        let version: Int?
        let enabledOps: [String]?
        let revealRoots: [String]?
        let overrides: [String: Override]?
    }

    static func load() -> WidgetActionsConfig {
        guard FileManager.default.fileExists(atPath: configPath.path) else { return .defaults }
        guard let data = try? Data(contentsOf: configPath),
              let raw = try? JSONDecoder().decode(Raw.self, from: data) else {
            FileHandle.standardError.write(Data("nyx: widget-actions.json unreadable — using defaults\n".utf8))
            return .defaults
        }
        var cfg = WidgetActionsConfig.defaults
        if let ops = raw.enabledOps {
            cfg.enabledOps = Set(ops).intersection(WidgetActionRegistry.opIds)
        }
        if let roots = raw.revealRoots, !roots.isEmpty {
            cfg.revealRoots = roots.map(WidgetActionRegistry.expandPath)
        }
        if let ov = raw.overrides {
            cfg.overrides = ov.filter { WidgetActionRegistry.opIds.contains($0.key) }
        }
        return cfg
    }
}

// MARK: - Registry

// The closed set of executable capabilities. Adding a genuinely new capability is
// a one-entry code change here (always code-reviewed); JSON can never define new
// behavior. See the widget-action-buttons-allowlist decision node.
enum WidgetActionRegistry {
    // Registry ids — the vocabulary widget-actions.json `enabledOps`/`overrides`
    // may reference. nav/reveal gate their whole kind; the rest gate one op each.
    static let opIds: Set<String> = ["nav", "reveal", "tick", "refresh", "resume", "pipelineDecision"]

    // Decision verbs submitDecision accepts (pipeline/decide.ts) — validated here
    // so a typo'd manifest renders disabled instead of bouncing off the dispatcher.
    private static let decisionVerbs: Set<String> = ["go", "revise", "abort", "proceed", "fix", "rollback", "accept"]

    // MARK: resolve (cadence-time, store-side — does file IO for reveal targets)

    static func resolveAll(_ actions: [WidgetAction], manifestId: String,
                           config: WidgetActionsConfig, dashboardIds: Set<String>) -> [ResolvedWidgetAction] {
        actions.enumerated().map { idx, a in
            resolve(a, id: "\(manifestId).\(idx)", config: config, dashboardIds: dashboardIds)
        }
    }

    static func resolve(_ action: WidgetAction, id: String,
                        config: WidgetActionsConfig, dashboardIds: Set<String>) -> ResolvedWidgetAction {
        let opId = registryId(action)
        let label = config.overrides[opId]?.label ?? action.label
        let icon = config.overrides[opId]?.icon ?? action.icon

        func enabled(_ op: WidgetOp, _ help: String) -> ResolvedWidgetAction {
            ResolvedWidgetAction(id: id, label: label, icon: icon, help: help, op: op)
        }
        func disabled(_ reason: String) -> ResolvedWidgetAction {
            ResolvedWidgetAction(id: id, label: label, icon: icon, help: reason, op: nil)
        }

        // An op id outside the registry never executes; it renders disabled so the
        // operator can see what the manifest asked for.
        guard opIds.contains(opId) else { return disabled("unknown action") }
        guard config.enabledOps.contains(opId) else {
            return disabled("disabled by operator (widget-actions.json)")
        }

        switch action.kind {
        case .nav:
            switch action.target {
            case "monitor": return enabled(.nav(.monitor), "Go to Monitor")
            case "apps":    return enabled(.nav(.apps), "Go to Apps")
            case "tasks":   return enabled(.nav(.tasks), "Go to Tasks")
            default:
                if let dashId = suffix(action.target, after: "dashboard:") {
                    guard dashboardIds.contains(dashId) else { return disabled("unknown dashboard: \(dashId)") }
                    return enabled(.nav(.dashboard(dashId)), "Open dashboard")
                }
                return disabled("unknown destination: \(action.target)")
            }

        case .reveal:
            switch revealURL(action.target, config: config) {
            case .success(let url): return enabled(.reveal(url), "Reveal in Finder")
            case .failure(let why): return disabled(why)
            }

        case .op:
            switch action.target {
            case "tick":    return enabled(.tick, "Run one dispatch tick now")
            case "refresh": return enabled(.refresh, "Reload state")
            default:
                if let taskId = suffix(action.target, after: "resume:") {
                    guard !taskId.isEmpty else { return disabled("malformed target: missing task id") }
                    return enabled(.resume(taskId), "Resume \(taskId)")
                }
                if let rest = suffix(action.target, after: "pipelineDecision:") {
                    let parts = rest.split(separator: ":", maxSplits: 1).map(String.init)
                    guard parts.count == 2, !parts[0].isEmpty, decisionVerbs.contains(parts[1]) else {
                        return disabled("malformed target: expected pipelineDecision:<runId>:<decision>")
                    }
                    return enabled(.pipelineDecision(runId: parts[0], decision: parts[1]),
                                   "Submit \(parts[1]) on \(parts[0])")
                }
                return disabled("unknown action")
            }
        }
    }

    // The registry id an action is gated by: the kind for nav/reveal, the named
    // op (everything before the first colon) for op targets.
    private static func registryId(_ action: WidgetAction) -> String {
        switch action.kind {
        case .nav:    return "nav"
        case .reveal: return "reveal"
        case .op:     return String(action.target.split(separator: ":", maxSplits: 1).first ?? "")
        }
    }

    // MARK: perform (tap-time, main-actor — no IO beyond the action itself)

    @MainActor
    static func perform(_ op: WidgetOp, store: Store, router: ActionRouter) {
        switch op {
        case .nav(let target):
            router.navigate(target)
        case .reveal(let url):
            NSWorkspace.shared.activateFileViewerSelecting([url])
        case .tick:
            store.runTick()
        case .refresh:
            store.refresh()
        case .resume(let taskId):
            // The existing resume_task pending_action; the next tick drains it.
            _ = Database.enqueueAction("resume_task", params: ["taskId": taskId])
            store.refresh()
        case .pipelineDecision(let runId, let decision):
            // Store.decide owns the existing pipeline_decision enqueue + tick path.
            store.decide(runId, decision, note: nil)
        }
    }

    // MARK: reveal target resolution + path validation

    // A reveal target resolves to a validated URL or a human reason it was refused
    // (rendered as the disabled button's tooltip).
    private enum RevealResolution {
        case success(URL)
        case failure(String)
    }

    // Map a reveal target to a candidate path. Names embedded in targets must be
    // a single path component — a "/" or ".." is refused before any FS touch
    // (validation would also catch the escape, this just fails it earlier).
    private static func revealURL(_ target: String, config: WidgetActionsConfig) -> RevealResolution {
        let candidates: [String]
        switch target {
        case "outputs":
            candidates = [Layout.dataDir.appendingPathComponent("outputs").path]
        case "ledger":
            candidates = [Layout.dataDir.appendingPathComponent("ledger").path]
        default:
            if let name = suffix(target, after: "app:") {
                guard isPlainComponent(name) else { return .failure("invalid app name") }
                candidates = [Layout.appsDir.appendingPathComponent(name).path]
            } else if let runId = suffix(target, after: "deliverable:") {
                guard isPlainComponent(runId) else { return .failure("invalid run id") }
                // Pipeline deliverables land in Data/projects/<task> (greenfield)
                // or appsDir/<slug> (app mode) — try both.
                candidates = [
                    Layout.dataDir.appendingPathComponent("projects").appendingPathComponent(runId).path,
                    Layout.appsDir.appendingPathComponent(runId).path,
                ]
            } else {
                return .failure("unknown reveal target: \(target)")
            }
        }
        for candidate in candidates {
            if let url = validated(candidate, roots: config.revealRoots) { return .success(url) }
        }
        return .failure(FileManager.default.fileExists(atPath: candidates[0])
            ? "path outside allowed reveal roots"
            : "not found: \(target)")
    }

    // Resolve the candidate to its REAL path (realpath: symlinks resolved, ../
    // collapsed; fails if the path doesn't exist) and require it to sit under one
    // of the allowed roots, themselves realpath'd. An escaping target is refused
    // and logged, never opened.
    private static func validated(_ path: String, roots: [String]) -> URL? {
        guard let real = realPath(path) else { return nil }
        for root in roots {
            guard let rootReal = realPath(expandPath(root)) else { continue }
            if real == rootReal || real.hasPrefix(rootReal + "/") {
                return URL(fileURLWithPath: real)
            }
        }
        FileHandle.standardError.write(Data("nyx: refused widget reveal outside allowed roots: \(real)\n".utf8))
        return nil
    }

    private static func realPath(_ path: String) -> String? {
        var buf = [CChar](repeating: 0, count: Int(PATH_MAX))
        guard realpath(path, &buf) != nil else { return nil }
        return String(cString: buf)
    }

    private static func isPlainComponent(_ name: String) -> Bool {
        !name.isEmpty && !name.contains("/") && name != "." && name != ".."
    }

    // Expand a leading ~ and any $NYX_DATA_DIR occurrence — the same vocabulary
    // StatusResolver's file source accepts.
    static func expandPath(_ path: String) -> String {
        var p = path
        if p.contains("$NYX_DATA_DIR") {
            p = p.replacingOccurrences(of: "$NYX_DATA_DIR", with: Layout.dataDir.path)
        }
        return NSString(string: p).expandingTildeInPath
    }

    private static func suffix(_ s: String, after prefix: String) -> String? {
        s.hasPrefix(prefix) ? String(s.dropFirst(prefix.count)) : nil
    }
}
