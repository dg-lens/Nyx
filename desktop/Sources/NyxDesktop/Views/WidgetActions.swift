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
// reveal targets may resolve (an explicit empty array = no roots; an absent key
// = defaults). `allowDestructiveOps` (default false) is the only way to surface
// abort/rollback/resume. Missing file = sensible defaults (non-destructive ops
// enabled, default roots, destructive ops OFF); corrupt or unknown-version file =
// defaults + a stderr note, never a crash and never anything newly executable
// (DashboardStore's corrupt-safe posture). The app never writes this file.
struct WidgetActionsConfig {
    struct Override: Decodable { let label: String?; let icon: String? }

    var enabledOps: Set<String>
    var revealRoots: [String]
    var overrides: [String: Override]
    // Gate for irreversible verbs — abort/rollback (via pipelineDecision) and the
    // resume op. OFF by default; only an explicit widget-actions.json edit turns it
    // on. See `defaults` for the rationale.
    var allowDestructiveOps: Bool

    static var configPath: URL { Layout.dataDir.appendingPathComponent("widget-actions.json") }

    // Default roots: outputs, ledger, the apps dir, and pipeline deliverables
    // (Data/projects) — the known output surfaces, nothing else.
    //
    // SECURITY — destructive ops are OPT-IN, not opt-out. Widget manifests are
    // operator-droppable AND mesh-synced, and the manifest controls each button's
    // LABEL — so a hostile or mis-synced manifest can mislabel a destructive op
    // (e.g. a "Refresh"-labelled button whose target is pipelineDecision:<run>:abort).
    // Therefore the irreversible ops must never be live out of the box:
    //   * `resume` is omitted from the default enabledOps, and
    //   * pipelineDecision's destructive verbs (abort, rollback) are refused at
    //     resolve time,
    // both UNLESS `allowDestructiveOps: true`. That single flag is the authoritative
    // opt-in: when set, resume resolves even though it's absent from enabledOps, and
    // the destructive pipeline verbs resolve too. Default enabled: nav, reveal, tick,
    // refresh, and pipelineDecision — the latter surfacing only its non-destructive
    // verbs (go/proceed/accept) until the operator opts destructive ops back in.
    static let defaultEnabledOps: Set<String> = ["nav", "reveal", "tick", "refresh", "pipelineDecision"]

    // Registry op-ids that are destructive. They bypass the enabledOps membership
    // gate when allowDestructiveOps is set (the flag is the single opt-in), and are
    // refused otherwise — so leaving them out of defaultEnabledOps keeps them off by
    // default without forcing the operator to BOTH set the flag AND list the id.
    static let destructiveOpIds: Set<String> = ["resume"]

    static var defaults: WidgetActionsConfig {
        WidgetActionsConfig(
            enabledOps: defaultEnabledOps,
            revealRoots: [
                Layout.dataDir.appendingPathComponent("outputs").path,
                Layout.dataDir.appendingPathComponent("ledger").path,
                Layout.appsDir.path,
                Layout.dataDir.appendingPathComponent("projects").path,
            ],
            overrides: [:],
            allowDestructiveOps: false)
    }

    private struct Raw: Decodable {
        let version: Int?
        let enabledOps: [String]?
        let revealRoots: [String]?
        let overrides: [String: Override]?
        let allowDestructiveOps: Bool?
    }

    static func load() -> WidgetActionsConfig {
        guard FileManager.default.fileExists(atPath: configPath.path) else { return .defaults }
        guard let data = try? Data(contentsOf: configPath) else {
            FileHandle.standardError.write(Data("nyx: widget-actions.json unreadable — using defaults\n".utf8))
            return .defaults
        }
        return load(data: data)
    }

    // Decode-and-apply, split out from file IO so the config semantics (version
    // guard, empty-array handling, intersection) are exercisable from raw bytes.
    static func load(data: Data) -> WidgetActionsConfig {
        guard let raw = try? JSONDecoder().decode(Raw.self, from: data) else {
            FileHandle.standardError.write(Data("nyx: widget-actions.json unreadable — using defaults\n".utf8))
            return .defaults
        }
        // Version guard: this loader implements schema version 1 only. A present-but-
        // unknown version means the file was written for a future schema whose
        // semantics we can't honor — fall back to defaults rather than silently
        // applying v1 semantics to a v2 file (which could enable more than the
        // author intended).
        if let v = raw.version, v != 1 {
            FileHandle.standardError.write(Data(
                "nyx: widget-actions.json version \(v) unsupported (expected 1) — using defaults\n".utf8))
            return .defaults
        }
        var cfg = WidgetActionsConfig.defaults
        if let ops = raw.enabledOps {
            cfg.enabledOps = Set(ops).intersection(WidgetActionRegistry.opIds)
        }
        // An ABSENT revealRoots falls back to defaults; an explicitly-present array
        // is honored verbatim, INCLUDING an empty array — `[]` means "no roots, all
        // reveals refused", mirroring how `enabledOps: []` means "no ops enabled".
        if let roots = raw.revealRoots {
            cfg.revealRoots = roots.map(WidgetActionRegistry.expandPath)
        }
        if let ov = raw.overrides {
            cfg.overrides = ov.filter { WidgetActionRegistry.opIds.contains($0.key) }
        }
        if let allow = raw.allowDestructiveOps {
            cfg.allowDestructiveOps = allow
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

    // Decision verbs a widget button may submit. NOTE these are a SUBSET of the
    // verbs submitDecision (pipeline/decide.ts) accepts: `revise` and `fix` are
    // deliberately excluded because the pipeline rejects them without a `note`,
    // and perform() submits with note: nil — a widget can't prompt for one. A
    // revise/fix button would therefore render enabled yet always bounce off the
    // dispatcher, so it's gated out here as "unknown verb" instead.
    private static let decisionVerbs: Set<String> = ["go", "abort", "proceed", "rollback", "accept"]

    // The irreversible subset of decisionVerbs. These (plus the `resume` op) only
    // resolve to a live button when config.allowDestructiveOps is true — see the
    // SECURITY note on WidgetActionsConfig.defaults. A manifest cannot enable them
    // on its own; only an operator edit to widget-actions.json can.
    private static let destructiveVerbs: Set<String> = ["abort", "rollback"]

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
        // A destructive op-id (resume) is deliberately absent from defaultEnabledOps;
        // the allowDestructiveOps flag is its opt-in, so let it through the membership
        // gate when the flag is set (the per-branch guard still enforces the flag).
        let opEnabled = config.enabledOps.contains(opId)
            || (config.allowDestructiveOps && WidgetActionsConfig.destructiveOpIds.contains(opId))
        guard opEnabled else {
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
                    // resume is destructive (it re-launches a halted task) — opt-in only.
                    guard config.allowDestructiveOps else {
                        return disabled("destructive op disabled (set allowDestructiveOps in widget-actions.json)")
                    }
                    return enabled(.resume(taskId), "Resume \(taskId)")
                }
                if let rest = suffix(action.target, after: "pipelineDecision:") {
                    let parts = rest.split(separator: ":", maxSplits: 1).map(String.init)
                    guard parts.count == 2, !parts[0].isEmpty, decisionVerbs.contains(parts[1]) else {
                        return disabled("malformed target: expected pipelineDecision:<runId>:<decision>")
                    }
                    // abort/rollback are irreversible — refuse unless explicitly opted in,
                    // so a mislabeled mesh-synced manifest can't surface a working one.
                    if destructiveVerbs.contains(parts[1]), !config.allowDestructiveOps {
                        return disabled("destructive op disabled (set allowDestructiveOps in widget-actions.json)")
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
            // Mirror Store.decide: a failed enqueue (SQLITE_BUSY past the busy
            // timeout) must stay visible, not be silently swallowed — surface it on
            // the same published field the toolbar reads.
            let ok = Database.enqueueAction("resume_task", params: ["taskId": taskId])
            store.lastDecision = ok ? "" : "Resume not recorded (DB busy). Tap again to retry."
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

// MARK: - Config / resolve self-tests
//
// No XCTest harness ships with this target — the build is the Swift gate, so these
// compile (and type-check) with the app and assert the pre-merge invariants. They
// do no filesystem IO (resolve's reveal branch is the only FS path and these don't
// exercise it), so `WidgetActionsTests.runAll()` is runnable as a standalone
// `@main`-free snippet. `runAll()` is intentionally never called at app launch.
enum WidgetActionsTests {
    private static func action(_ kind: WidgetAction.Kind, _ target: String) -> WidgetAction {
        WidgetAction(label: "btn", icon: nil, kind: kind, target: target)
    }

    private static func resolve(_ target: String, _ config: WidgetActionsConfig) -> ResolvedWidgetAction {
        WidgetActionRegistry.resolve(action(.op, target), id: "t", config: config, dashboardIds: [])
    }

    // Item 1: a default-config manifest targeting pipelineDecision:<run>:abort renders
    // disabled; flipping allowDestructiveOps makes it live. resume mirrors this.
    static func destructiveOpsDefaultOff() {
        let def = WidgetActionsConfig.defaults
        assert(def.allowDestructiveOps == false, "destructive ops must default OFF")
        assert(resolve("pipelineDecision:run1:abort", def).op == nil,
               "abort must render disabled under default config")
        assert(resolve("pipelineDecision:run1:rollback", def).op == nil,
               "rollback must render disabled under default config")
        assert(resolve("resume:TASK-9", def).op == nil,
               "resume must render disabled under default config")
        // Non-destructive pipeline verbs stay live by default.
        if case .pipelineDecision = resolve("pipelineDecision:run1:go", def).op {} else {
            assertionFailure("go must stay live under default config")
        }

        var allow = WidgetActionsConfig.defaults
        allow.allowDestructiveOps = true
        if case .pipelineDecision(_, "abort") = resolve("pipelineDecision:run1:abort", allow).op {} else {
            assertionFailure("abort must be live once allowDestructiveOps is set")
        }
        if case .resume = resolve("resume:TASK-9", allow).op {} else {
            assertionFailure("resume must be live once allowDestructiveOps is set")
        }
    }

    // Item 2: an explicit empty revealRoots means NO roots; an absent key = defaults.
    static func emptyRevealRootsMeansNone() {
        let none = WidgetActionsConfig.load(data: Data(#"{"version":1,"revealRoots":[]}"#.utf8))
        assert(none.revealRoots.isEmpty, "explicit [] revealRoots must stay empty")
        let absent = WidgetActionsConfig.load(data: Data(#"{"version":1}"#.utf8))
        assert(absent.revealRoots.count == WidgetActionsConfig.defaults.revealRoots.count,
               "absent revealRoots must fall back to defaults")
    }

    // Item 3: note-requiring verbs (revise, fix) are not widget decision verbs, so
    // such a button renders disabled rather than enabled-but-always-bounce.
    static func noteVerbsDropped() {
        let allow = { var c = WidgetActionsConfig.defaults; c.allowDestructiveOps = true; return c }()
        assert(resolve("pipelineDecision:run1:revise", allow).op == nil,
               "revise must render disabled (needs a note a widget can't supply)")
        assert(resolve("pipelineDecision:run1:fix", allow).op == nil,
               "fix must render disabled (needs a note a widget can't supply)")
    }

    // Item 4: an unknown version falls back to defaults (no silent v1 semantics).
    static func versionGuard() {
        let v2 = WidgetActionsConfig.load(data: Data(#"{"version":2,"enabledOps":[]}"#.utf8))
        assert(v2.enabledOps == WidgetActionsConfig.defaults.enabledOps,
               "version != 1 must ignore the file and use defaults")
        let v1 = WidgetActionsConfig.load(data: Data(#"{"version":1,"enabledOps":[]}"#.utf8))
        assert(v1.enabledOps.isEmpty, "version 1 with enabledOps:[] must apply (no ops)")
    }

    static func runAll() {
        destructiveOpsDefaultOff()
        emptyRevealRootsMeansNone()
        noteVerbsDropped()
        versionGuard()
    }
}
