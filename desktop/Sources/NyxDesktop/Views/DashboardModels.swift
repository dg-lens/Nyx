import Foundation

// A cell-sized footprint: width/height measured in grid cells.
struct WidgetSize: Codable, Hashable {
    var w: Int
    var h: Int
}

// Where a widget's data comes from. `static` text is user-editable and stored in
// the dashboard layout (per widget instance). `store` resolves a key against live
// Store state via the key->value resolver in WidgetManifestLoader.
enum WidgetSource: Codable, Hashable {
    case staticText
    case store(key: String)

    enum CodingKeys: String, CodingKey { case kind, key }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "store":
            self = .store(key: try c.decode(String.self, forKey: .key))
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
        }
    }
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
    let viz: String              // "text" | "stat"
    let source: WidgetSource
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
