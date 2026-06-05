import Foundation
import SwiftUI

// Mirrors apps/dispatcher/src/settings.ts (Data/settings.json).
struct PipelineSettings: Codable {
    var concurrentCap: Int = 4
    var slackNotifications: Bool = true
    var autoMerge: Bool = false
    var reviewStrictness: String = "normal"
}

struct DispatcherSettings: Codable {
    var maxChainDepth: Int = 2
    var taskTimeoutMs: Int = 1_800_000
    var concurrencyGuard: Bool = true
    var defaultModels: [String: String] = [
        "code": "sonnet", "analysis": "opus", "content": "sonnet", "assistant": "haiku", "pipeline": "opus",
    ]
}

struct PluginSettings: Codable {
    var disabled: [String] = []
}

struct NyxSettings: Codable {
    var pipeline = PipelineSettings()
    var dispatcher = DispatcherSettings()
    var plugins = PluginSettings()
}

struct PluginInfo: Identifiable {
    var id: String { name }
    let name: String
    let tier: String       // approved | local
    let runtime: String    // tick | host | both
    let source: String     // stock | local
    var enabled: Bool
    let env: [String]      // declared env var names
}

@MainActor
final class SettingsStore: ObservableObject {
    @Published var settings = NyxSettings()
    @Published var instanceName = ""
    @Published var operatorName = ""
    @Published var slackChannel = ""
    @Published var memoryBackend = ""
    @Published var plugins: [PluginInfo] = []
    @Published var daemonRunning = false
    @Published var hasApiKey = false
    @Published var status = ""

    private var env: [String: String] = [:]

    func load() {
        env = Self.readEnv()
        instanceName = env["NAME"] ?? env["NYX_NAME"] ?? "Nyx"
        operatorName = env["OPERATOR_NAME"] ?? ""
        slackChannel = env["SLACK_CHANNEL"] ?? ""
        memoryBackend = env["NYX_MEMORY_BACKEND"] ?? "local-obsidian"
        hasApiKey = !(env["ANTHROPIC_API_KEY"] ?? "").isEmpty
        settings = Self.loadSettings()
        scanPlugins()
        refreshDaemonStatus()
    }

    // MARK: settings.json

    static func loadSettings() -> NyxSettings {
        guard let data = try? Data(contentsOf: Layout.settingsPath),
              let s = try? JSONDecoder().decode(NyxSettings.self, from: data) else { return NyxSettings() }
        return s
    }

    func saveSettings() {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(settings) {
            try? data.write(to: Layout.settingsPath)
            flash("Saved settings.json")
        }
    }

    // MARK: .env

    static func readEnv() -> [String: String] {
        guard let text = try? String(contentsOf: Layout.envPath, encoding: .utf8) else { return [:] }
        var dict: [String: String] = [:]
        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = String(line[..<eq]).trimmingCharacters(in: .whitespaces)
            let val = String(line[line.index(after: eq)...]).trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
            dict[key] = val
        }
        return dict
    }

    func saveEnv(_ updates: [String: String]) {
        var lines = (try? String(contentsOf: Layout.envPath, encoding: .utf8))?
            .components(separatedBy: .newlines) ?? []
        var remaining = updates
        for i in lines.indices {
            let line = lines[i].trimmingCharacters(in: .whitespaces)
            guard !line.hasPrefix("#"), let eq = line.firstIndex(of: "=") else { continue }
            let key = String(line[..<eq]).trimmingCharacters(in: .whitespaces)
            if let v = remaining[key] {
                lines[i] = "\(key)=\(v)"
                remaining.removeValue(forKey: key)
            }
        }
        for (k, v) in remaining where !v.isEmpty { lines.append("\(k)=\(v)") }
        try? lines.joined(separator: "\n").write(to: Layout.envPath, atomically: true, encoding: .utf8)
        for (k, v) in updates { env[k] = v }
        flash("Saved .env")
    }

    func saveIdentity() {
        saveEnv([
            "NAME": instanceName.trimmingCharacters(in: .whitespaces),
            "OPERATOR_NAME": operatorName.trimmingCharacters(in: .whitespaces),
        ])
    }

    func saveIntegrations() {
        saveEnv(["SLACK_CHANNEL": slackChannel, "NYX_MEMORY_BACKEND": memoryBackend])
    }

    // MARK: plugins

    func scanPlugins() {
        var out: [PluginInfo] = []
        let dirs: [(URL, String)] = [(Layout.stockPluginsDir, "stock"), (Layout.pluginsDir, "local")]
        for (dir, source) in dirs {
            guard let entries = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil) else { continue }
            for entry in entries {
                let manifest = entry.appendingPathComponent("nyx-plugin.json")
                guard let data = try? Data(contentsOf: manifest),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let name = obj["name"] as? String else { continue }
                let caps = obj["capabilities"] as? [String: Any]
                out.append(PluginInfo(
                    name: name,
                    tier: (obj["tier"] as? String) ?? "?",
                    runtime: (obj["runtime"] as? String) ?? "tick",
                    source: source,
                    enabled: !settings.plugins.disabled.contains(name),
                    env: (caps?["env"] as? [String]) ?? []
                ))
            }
        }
        plugins = out.sorted { $0.name < $1.name }
    }

    func setPlugin(_ name: String, enabled: Bool) {
        var disabled = Set(settings.plugins.disabled)
        if enabled { disabled.remove(name) } else { disabled.insert(name) }
        settings.plugins.disabled = disabled.sorted()
        saveSettings()
        scanPlugins()
    }

    // MARK: daemon (brew services / launchctl)

    func refreshDaemonStatus() {
        DispatchQueue.global().async {
            let running = Self.shell("launchctl list 2>/dev/null | grep -q com.nyx.dispatcher")
            DispatchQueue.main.async { [weak self] in self?.daemonRunning = running }
        }
    }

    func daemonStart() { runBrew("services start dg-lens/nyx/nyx", note: "Starting daemon…") }
    func daemonStop() { runBrew("services stop dg-lens/nyx/nyx", note: "Stopping daemon…") }

    private func runBrew(_ args: String, note: String) {
        flash(note)
        DispatchQueue.global().async {
            _ = Self.shell("/opt/homebrew/bin/brew \(args)")
            DispatchQueue.main.async { [weak self] in self?.refreshDaemonStatus() }
        }
    }

    @discardableResult
    nonisolated static func shell(_ cmd: String) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", cmd]
        var e = ProcessInfo.processInfo.environment
        e["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (e["PATH"] ?? "/usr/bin:/bin")
        p.environment = e
        do { try p.run(); p.waitUntilExit(); return p.terminationStatus == 0 } catch { return false }
    }

    private func flash(_ msg: String) {
        status = msg
    }
}

// Set the running app's dock icon from the logo at runtime (nil logo restores
// the bundle icon). Avoids the macOS dock-icon cache that ignores a rebuilt
// .icns until relaunch/Dock restart.
@MainActor
func applyDockIcon() {
    NSApplication.shared.applicationIconImage = NSImage(contentsOf: Layout.logoPath)
}
