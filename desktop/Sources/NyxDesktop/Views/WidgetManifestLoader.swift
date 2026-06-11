import Foundation

// Loads widget manifests from two sources, merged by id (Data-dir wins on a
// collision so a custom drop-in can shadow a stock widget):
//   1. Stock manifests — the embedded-strings set below. Embedded rather than
//      bundled resource files: build.sh produces a bare .app with no SwiftPM
//      resource bundle, so embedding keeps ONE canonical stock set with no
//      duplicate JSON to drift.
//   2. $NYX_DATA_DIR/widgets/*.json — scanned at launch + on refresh. THIS is the
//      plugin/custom hook: future plugins or generated role-scoped dashboards just
//      drop JSON files here, no app rebuild.
//
// Invalid/corrupt manifests are skipped with a console note, never crash.
//
// Actions schema (optional `actions` array on a manifest):
//
//   "actions": [ { "label": "Open ledger", "icon": "folder",
//                  "kind": "reveal", "target": "ledger" } ]
//
// `kind` is a CLOSED enum — nav | reveal | op — and `target` names a capability
// from the code-defined WidgetActionRegistry (Views/WidgetActions.swift):
//
//   nav:    monitor | apps | tasks | dashboard:<id>     (switch tab/dashboard)
//   reveal: outputs | ledger | app:<name> | deliverable:<runId>
//           (reveal in Finder; the resolved REAL path must sit under an allowed
//            root or the button renders disabled — never opened)
//   op:     tick | refresh | resume:<taskId> | pipelineDecision:<runId>:<decision>
//           (named Nyx operations reusing the existing Store/Database paths)
//
// There is NO raw-command/shell/exec field — manifests are operator-droppable
// (and mesh-shareable) JSON, so they may only REFERENCE named capabilities; a
// free-form command field would be an arbitrary-code-execution vector. An
// unknown kind or malformed entry is skipped on decode; an op id outside the
// registry renders a disabled button. See the widget-action-buttons-allowlist
// decision node.
//
// Operator allowlist config — $NYX_DATA_DIR/widget-actions.json (optional):
//
//   { "version": 1,
//     "enabledOps": ["tick","refresh","resume","pipelineDecision","nav","reveal"],
//     "allowDestructiveOps": true,
//     "revealRoots": ["~/Nyx/Data/outputs","~/Nyx/Data/ledger",
//                     "~/Nyx/Apps","$NYX_DATA_DIR/projects"],
//     "overrides": { "tick": { "label": "Tick", "icon": "bolt.fill" } } }
//
// It can only NARROW or relabel what the registry defines: unknown ids are
// ignored, a disabled op renders its button disabled (with help text) rather
// than hidden, and no config value can add executable behavior. Missing file =
// defaults: the non-destructive ops (nav, reveal, tick, refresh, pipelineDecision
// go/proceed/accept) enabled with the four default reveal roots above, and the
// destructive ops (abort, rollback, resume) OFF. `allowDestructiveOps: true` is
// the only way to surface them — the example sets it because it also lists
// `resume`. An explicit `"revealRoots": []` means NO roots (all reveals refused);
// only an absent key falls back to the four defaults. A corrupt OR unknown-version
// file = defaults + a stderr note. See WidgetActionsConfig.
enum WidgetManifestLoader {
    // Stock manifests as embedded JSON strings — the always-present fallback. One
    // text/note widget plus three store-key stat widgets that prove the live hook.
    static let embeddedStock: [String] = [
        """
        { "id": "note", "pluginId": "core", "title": "Note",
          "description": "A free-text note you can edit inline.",
          "defaultSize": { "w": 3, "h": 2 }, "viz": "text",
          "source": { "kind": "static" } }
        """,
        """
        { "id": "queueCount", "pluginId": "core", "title": "Queue",
          "description": "Pending + standing tasks in the queue.",
          "defaultSize": { "w": 2, "h": 2 }, "viz": "stat",
          "source": { "kind": "store", "key": "queueCount" } }
        """,
        """
        { "id": "gatesWaiting", "pluginId": "core", "title": "Gates Waiting",
          "description": "Pipeline runs awaiting an operator gate decision.",
          "defaultSize": { "w": 2, "h": 2 }, "viz": "stat",
          "source": { "kind": "store", "key": "gatesWaiting" } }
        """,
        """
        { "id": "lastTick", "pluginId": "core", "title": "Last Tick",
          "description": "When the dispatcher last ran a tick.",
          "defaultSize": { "w": 2, "h": 2 }, "viz": "stat",
          "source": { "kind": "store", "key": "lastTick" } }
        """,
        // nyx-ops status panels — health dot + lines + freshness footer. Each
        // reads live Store state or a Data-dir file; see StatusResolver.
        """
        { "id": "opsDispatcher", "pluginId": "nyx-ops", "title": "Dispatcher Health",
          "description": "Tick heartbeat + self-update marker.",
          "defaultSize": { "w": 2, "h": 2 }, "viz": "status",
          "source": { "kind": "store", "key": "ops.dispatcher" } }
        """,
        """
        { "id": "opsGates", "pluginId": "nyx-ops", "title": "Gates",
          "description": "Pipeline runs awaiting an operator gate decision.",
          "defaultSize": { "w": 2, "h": 2 }, "viz": "status",
          "source": { "kind": "store", "key": "ops.gates" } }
        """,
        """
        { "id": "opsQueue", "pluginId": "nyx-ops", "title": "Queue",
          "description": "Standing + scheduled tasks and the next task ids.",
          "defaultSize": { "w": 2, "h": 2 }, "viz": "status",
          "source": { "kind": "store", "key": "ops.queue" } }
        """,
        // Demonstrates the actions schema: one reveal + one named op, both
        // resolved against the WidgetActionRegistry allowlist.
        """
        { "id": "opsLedger", "pluginId": "nyx-ops", "title": "Today's Activity",
          "description": "The most recent day from the activity ledger.",
          "defaultSize": { "w": 4, "h": 2 }, "viz": "status",
          "source": { "kind": "store", "key": "ops.ledger" },
          "actions": [
            { "label": "Open ledger", "icon": "folder", "kind": "reveal", "target": "ledger" },
            { "label": "Tick now", "icon": "bolt.fill", "kind": "op", "target": "tick" } ] }
        """,
    ]

    // The Data-dir scan location: $NYX_DATA_DIR/widgets/*.json.
    static var dataWidgetsDir: URL { Layout.dataDir.appendingPathComponent("widgets") }

    private static let decoder = JSONDecoder()

    private static func decode(_ data: Data, note: String) -> WidgetManifest? {
        do {
            return try decoder.decode(WidgetManifest.self, from: data)
        } catch {
            FileHandle.standardError.write(Data("nyx: skipping invalid widget manifest (\(note)): \(error)\n".utf8))
            return nil
        }
    }

    // Load + merge all manifests, keyed by id. Data-dir entries override stock.
    static func loadAll() -> [String: WidgetManifest] {
        var out: [String: WidgetManifest] = [:]

        for json in embeddedStock {
            if let m = decode(Data(json.utf8), note: "embedded") { out[m.id] = m }
        }

        if let entries = try? FileManager.default.contentsOfDirectory(
            at: dataWidgetsDir, includingPropertiesForKeys: nil) {
            for entry in entries where entry.pathExtension.lowercased() == "json" {
                guard let data = try? Data(contentsOf: entry),
                      let m = decode(data, note: entry.lastPathComponent) else { continue }
                out[m.id] = m
            }
        }
        return out
    }
}

// Resolves a store-source key to a display value against live Store state. Keys
// the generation wave can rely on. Unknown keys render "—" rather than crash.
enum StoreKeyResolver {
    static func value(_ key: String, _ state: NyxState) -> String {
        switch key {
        case "queueCount":     return "\(state.queue.count)"
        case "standingCount":  return "\(standingCount(state))"
        case "gatesWaiting":   return "\(state.gates.count)"
        case "lastTick":       return state.lastTick
        case "auditCount":     return "\(state.audit.count)"
        case "health":         return state.healthy ? "Healthy" : "Idle"
        default:               return "—"
        }
    }

    // Standing tasks: queue items not tagged as a pending-tick/decomposing dispatch
    // (those are transient pre-drain rows). Best-effort from the QueueItem.type label.
    private static func standingCount(_ state: NyxState) -> Int {
        state.queue.filter { !$0.type.contains("pending") && !$0.type.contains("decomposing") }.count
    }

    // Human caption shown under a stat value so the number reads in context.
    static func caption(_ key: String) -> String {
        switch key {
        case "queueCount":    return "in queue"
        case "standingCount": return "standing"
        case "gatesWaiting":  return "awaiting gate"
        case "lastTick":      return "last tick"
        case "auditCount":    return "recent events"
        case "health":        return "status"
        default:              return key
        }
    }
}
