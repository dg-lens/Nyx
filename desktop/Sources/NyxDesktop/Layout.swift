import Foundation

enum Layout {
    private static var home: URL { FileManager.default.homeDirectoryForCurrentUser }
    private static func env(_ key: String) -> String? {
        let v = ProcessInfo.processInfo.environment[key]
        return (v?.isEmpty == false) ? v : nil
    }

    static var dataDir: URL {
        if let e = env("NYX_DATA_DIR") { return URL(fileURLWithPath: e) }
        return home.appendingPathComponent("Nyx/Data")
    }
    static var repoRoot: URL {
        if let e = env("NYX_REPO_ROOT") { return URL(fileURLWithPath: e) }
        return home.appendingPathComponent("Nyx/Core")
    }
    static var dbPath: URL { dataDir.appendingPathComponent("data/nyx.db") }
    static var queuePath: URL { dataDir.appendingPathComponent("nyx.md") }
    static var tickScript: URL { repoRoot.appendingPathComponent("scripts/nyx-tick.sh") }

    static var systemName: String {
        let envPath = dataDir.appendingPathComponent(".env")
        guard let text = try? String(contentsOf: envPath, encoding: .utf8) else { return "Nyx" }
        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            for key in ["NYX_NAME=", "name="] where line.lowercased().hasPrefix(key.lowercased()) {
                let value = line.dropFirst(key.count)
                    .trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
                if !value.isEmpty { return value }
            }
        }
        return "Nyx"
    }
}
