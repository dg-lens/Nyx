import Foundation

// Loads widget manifests from two sources, merged by id (Data-dir wins on a
// collision so a custom drop-in can shadow a stock widget):
//   1. Stock manifests — bundled with the app. We try the resource path
//      (desktop/Resources/widgets/*.json) first; if SwiftPM resource bundling
//      isn't present (build.sh copies only the logo), we fall back to the
//      embedded-strings set below so stock widgets always exist.
//   2. $NYX_DATA_DIR/widgets/*.json — scanned at launch + on refresh. THIS is the
//      plugin/custom hook: future plugins or generated role-scoped dashboards just
//      drop JSON files here, no app rebuild.
//
// Invalid/corrupt manifests are skipped with a console note, never crash.
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
        """
        { "id": "opsLedger", "pluginId": "nyx-ops", "title": "Today's Activity",
          "description": "The most recent day from the activity ledger.",
          "defaultSize": { "w": 4, "h": 2 }, "viz": "status",
          "source": { "kind": "store", "key": "ops.ledger" } }
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

        let resourceDir = Bundle.main.url(forResource: nil, withExtension: nil)?
            .appendingPathComponent("widgets")
        for dir in [resourceDir, dataWidgetsDir].compactMap({ $0 }) {
            guard let entries = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil) else { continue }
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
