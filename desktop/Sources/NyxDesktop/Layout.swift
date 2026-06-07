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
    static var pluginsDir: URL {
        if let e = env("NYX_PLUGINS_DIR") { return URL(fileURLWithPath: e) }
        return home.appendingPathComponent("Nyx/Plugins")
    }
    static var stockPluginsDir: URL { repoRoot.appendingPathComponent("plugins") }
    static var envPath: URL { dataDir.appendingPathComponent(".env") }
    static var settingsPath: URL { dataDir.appendingPathComponent("settings.json") }
    static var pipelineSecretsDir: URL { dataDir.appendingPathComponent("pipeline-secrets") }
    static func runSecretsPath(_ runId: String) -> URL { pipelineSecretsDir.appendingPathComponent("\(runId).env") }
    static func runDecisionsPath(_ runId: String) -> URL { pipelineSecretsDir.appendingPathComponent("\(runId).decisions.json") }
    static var logoPath: URL { dataDir.appendingPathComponent("logo.png") }
    static var repoDefaultLogo: URL { repoRoot.appendingPathComponent("desktop/Resources/default-logo.png") }
    static var bundledDefaultLogo: URL? { Bundle.main.url(forResource: "default-logo", withExtension: "png") }

    // Effective logo: per-instance override (Data/logo.png) -> shipped preset
    // (bundled, or the Core source asset) -> nil (caller falls back to a symbol).
    static var effectiveLogoURL: URL? {
        if FileManager.default.fileExists(atPath: logoPath.path) { return logoPath }
        if let bundled = bundledDefaultLogo { return bundled }
        if FileManager.default.fileExists(atPath: repoDefaultLogo.path) { return repoDefaultLogo }
        return nil
    }

    static var systemName: String {
        let envPath = dataDir.appendingPathComponent(".env")
        guard let text = try? String(contentsOf: envPath, encoding: .utf8) else { return "Nyx" }
        let lines = text.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        for key in ["NAME=", "NYX_NAME="] {
            for line in lines where line.lowercased().hasPrefix(key.lowercased()) {
                let value = line.dropFirst(key.count)
                    .trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
                if !value.isEmpty { return value }
            }
        }
        return "Nyx"
    }
}
