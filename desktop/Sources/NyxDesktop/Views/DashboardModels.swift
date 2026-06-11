import Foundation

// A cell-sized footprint: width/height measured in grid cells.
struct WidgetSize: Codable, Hashable {
    var w: Int
    var h: Int
}

// Where a widget's data comes from. `static` text is user-editable and stored in
// the dashboard layout (per widget instance). `store` resolves a key against live
// Store state via the key->value resolver in WidgetManifestLoader. `file` (added
// with the status viz) renders the tail of an operator-droppable text file — it
// reads only, never executes.
//
// Forgiving-decode contract: an UNKNOWN kind decodes to `.staticText` rather than
// throwing, so a manifest mixing a kind this build doesn't understand still loads
// (the loader's corrupt-safe scan keeps the rest of the file usable). A future
// kind that needs to be SKIPPED entirely is filtered at the manifest level (see
// WidgetManifest.init), not here.
enum WidgetSource: Codable, Hashable {
    case staticText
    case store(key: String)
    // Read-only file tail. `path` supports ~ and $NYX_DATA_DIR expansion; the
    // resolver renders the last `maxLines` non-empty lines and derives freshness
    // from the file mtime against `freshMinutes`. There is intentionally NO
    // command/shell source kind — widgets are operator-droppable JSON and a
    // command source would be an arbitrary-code-execution vector.
    case file(path: String, freshMinutes: Int, maxLines: Int)

    enum CodingKeys: String, CodingKey { case kind, key, path, freshMinutes, maxLines }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "store":
            self = .store(key: try c.decode(String.self, forKey: .key))
        case "file":
            let path = try c.decode(String.self, forKey: .path)
            let fresh = (try? c.decode(Int.self, forKey: .freshMinutes)) ?? 10
            let max = (try? c.decode(Int.self, forKey: .maxLines)) ?? 7
            self = .file(path: path, freshMinutes: fresh, maxLines: max)
        default:
            self = .staticText
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .staticText:
            try c.encode("static", forKey: .kind)
        case .store(let key):
            try c.encode("store", forKey: .kind)
            try c.encode(key, forKey: .key)
        case .file(let path, let freshMinutes, let maxLines):
            try c.encode("file", forKey: .kind)
            try c.encode(path, forKey: .path)
            try c.encode(freshMinutes, forKey: .freshMinutes)
            try c.encode(maxLines, forKey: .maxLines)
        }
    }
}

// One interactive button a manifest may declare. `kind` is a CLOSED enum — the
// manifest only ever REFERENCES a named capability; all executable behavior lives
// in the code-defined WidgetActionRegistry (Views/WidgetActions.swift). There is
// intentionally NO raw-command/shell/exec field anywhere in this schema: widget
// manifests are operator-droppable JSON (and mesh-shareable), so a free-form
// command field would be an arbitrary-code-execution vector — the same HARD RULE
// StatusResolver states for sources.
//
// Forgiving-decode contract: an UNKNOWN kind or a malformed entry is SKIPPED at
// the manifest level (see WidgetManifest.init) — it never crashes the manifest
// and never falls back to anything executable.
struct WidgetAction: Codable, Hashable {
    enum Kind: String, Codable, Hashable {
        case nav      // switch to a tab/dashboard: monitor | apps | tasks | dashboard:<id>
        case reveal   // reveal a VALIDATED path in Finder: outputs | ledger | app:<name> | deliverable:<runId>
        case op       // run a NAMED registry op: tick | refresh | resume:<taskId> | pipelineDecision:<runId>:<decision>
    }

    let label: String
    let icon: String?            // optional SF Symbol shown before the label
    let kind: Kind
    let target: String
}

// Decode shim for the actions array: a malformed entry (missing field, unknown
// kind) decodes to nil instead of throwing, so one bad action can't take down
// the whole manifest — mirroring WidgetSource's unknown-kind posture.
struct LossyWidgetAction: Decodable {
    let action: WidgetAction?
    init(from decoder: Decoder) { action = try? WidgetAction(from: decoder) }
}

// The declarative definition of a widget. NOT Swift code — these are loaded from
// JSON (embedded stock set + $NYX_DATA_DIR/widgets/*.json). The app renders by
// `viz` and resolves data by `source`. This shape is the contract the role-scoped
// generation wave will emit, so it stays stable and forgiving on decode.
struct WidgetManifest: Codable, Identifiable, Hashable {
    let id: String
    let pluginId: String
    let title: String
    let description: String?
    let defaultSize: WidgetSize
    let viz: String              // "text" | "stat" | "status"
    let source: WidgetSource
    // Optional interactive buttons (empty when absent). Each entry references a
    // named capability by kind+target; resolution + execution live in
    // WidgetActionRegistry. Malformed/unknown entries are skipped on decode.
    let actions: [WidgetAction]

    enum CodingKeys: String, CodingKey {
        case id, pluginId, title, description, defaultSize, viz, source, actions
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        pluginId = try c.decode(String.self, forKey: .pluginId)
        title = try c.decode(String.self, forKey: .title)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        defaultSize = try c.decode(WidgetSize.self, forKey: .defaultSize)
        viz = try c.decode(String.self, forKey: .viz)
        source = try c.decode(WidgetSource.self, forKey: .source)
        // Lossy: skip entries that fail to decode rather than failing the manifest.
        let lossy = try? c.decodeIfPresent([LossyWidgetAction].self, forKey: .actions)
        actions = (lossy ?? nil)?.compactMap(\.action) ?? []
    }
}

// A widget placed on a dashboard: which manifest, where on the grid, and (for
// static-source widgets) the user's editable text content.
struct WidgetInstance: Codable, Identifiable, Hashable {
    var instanceId: String
    var manifestId: String
    var col: Int
    var row: Int
    var w: Int
    var h: Int
    var text: String?            // static-source content; nil for store widgets

    var id: String { instanceId }
}

// One dashboard: a named page holding a set of placed widgets.
struct DashboardLayout: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var icon: String
    var widgets: [WidgetInstance]
}

// The persisted document at $NYX_DATA_DIR/dashboards.json: the full list of
// dashboards plus which one is starred (the primary/home dashboard). Exactly one
// id is starred at a time.
struct DashboardDoc: Codable {
    var version: Int
    var starredId: String
    var dashboards: [DashboardLayout]
}

// MARK: - Status widget data model
//
// The status viz renders a "dumb card": a header health dot + label, a body of up
// to seven caption lines, and a footer freshness badge. ALL values come from the
// StatusPayload a resolver produces — the view does no interpretation. This model
// is adapted from the IrisLiveOps QuadrantCard pattern (health bucket + lines +
// freshness state, per-source failure isolation) and rewritten for Nyx's idiom.

// Health bucket driving the header dot's colour + label. The dot stays a fixed
// size so a first-glance read isn't biased by content length.
enum HealthLevel: Equatable {
    case ok
    case warn
    case critical
    case unknown
}

// Per-source freshness, driving the footer symbol + text. `fresh`/`stale` carry
// the last-good read time; `preparing` is "no signal yet"; `error` carries a
// short message. A resolver that throws yields `.error` for ITS widget only —
// sibling widgets are unaffected (each resolver runs in its own do/catch).
enum FreshnessState: Equatable {
    case fresh(Date)
    case stale(Date)
    case preparing
    case error(String)
}

// The full backing value for one status widget. Produced by StatusResolver; the
// `preparing` factory is the never-fail default so a card never renders an
// unexplained blank.
struct StatusPayload: Equatable {
    var health: HealthLevel
    var lines: [String]
    var freshnessDate: Date?
    var state: FreshnessState

    static let preparing = StatusPayload(
        health: .unknown, lines: [], freshnessDate: nil, state: .preparing)

    static func error(_ message: String) -> StatusPayload {
        StatusPayload(health: .critical, lines: [], freshnessDate: nil, state: .error(message))
    }
}
