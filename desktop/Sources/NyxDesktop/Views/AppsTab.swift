import Foundation
import SwiftUI

// The Apps tab: renders ~/Nyx/Apps — agent-driven apps that use the Nyx
// substrate but run as standalone tools (LaunchAgent / CLI / .app). One
// directory per app, described by nyx-app.json; the contract lives in
// ~/Nyx/Apps/README.md. Read-only in v1: list + live launchd state, no
// start/stop controls.

// One installed app's manifest. Forgiving decode: only `name` is required,
// everything else defaults, and the loader skips corrupt files entirely —
// a bad drop-in never blanks the tab.
struct AppManifest: Identifiable {
    let name: String
    let title: String
    let version: String
    let description: String
    let icon: String
    let runtimeKind: String      // "launchagent" | "cli" | "app"
    let runtimeLabel: String?    // launchd label when kind == launchagent
    let substrate: [String]

    var id: String { name }
}

extension AppManifest: Decodable {
    enum CodingKeys: String, CodingKey { case name, title, version, description, icon, runtime, substrate }
    enum RuntimeKeys: String, CodingKey { case kind, label }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        title = (try? c.decode(String.self, forKey: .title)) ?? name
        version = (try? c.decode(String.self, forKey: .version)) ?? ""
        description = (try? c.decode(String.self, forKey: .description)) ?? ""
        icon = (try? c.decode(String.self, forKey: .icon)) ?? "shippingbox"
        if let r = try? c.nestedContainer(keyedBy: RuntimeKeys.self, forKey: .runtime) {
            runtimeKind = (try? r.decode(String.self, forKey: .kind)) ?? "cli"
            runtimeLabel = try? r.decode(String.self, forKey: .label)
        } else {
            runtimeKind = "cli"
            runtimeLabel = nil
        }
        substrate = (try? c.decode([String].self, forKey: .substrate)) ?? []
    }
}

// Live launchd state for a manifest's runtime label.
enum AppRunState: Equatable {
    case running(pid: Int)
    case loaded
    case notLoaded
    case notApplicable   // cli / app runtimes have no launchd state
}

struct AppEntry: Identifiable {
    let manifest: AppManifest
    let state: AppRunState
    var id: String { manifest.id }
}

// Owns the scan + probe. Both run off the main actor (manifest reads are file
// IO, the probe execs `launchctl list` once per refresh) and publish one batch,
// generation-guarded so a stale slow scan never overwrites a newer one — the
// same pattern as Store.refresh / DashboardStore.refreshStatusPayloads.
@MainActor
final class AppsStore: ObservableObject {
    @Published private(set) var entries: [AppEntry] = []
    @Published private(set) var scannedOnce = false

    private var generation = 0

    func refresh() {
        generation += 1
        let gen = generation
        Task.detached(priority: .utility) {
            let manifests = AppsStore.scanManifests()
            let table = manifests.contains(where: { $0.runtimeKind == "launchagent" })
                ? AppsStore.launchdTable()
                : [:]
            let result = manifests.map { AppEntry(manifest: $0, state: AppsStore.state(for: $0, in: table)) }
            await MainActor.run { [weak self] in
                guard let self, gen == self.generation else { return }
                self.entries = result
                self.scannedOnce = true
            }
        }
    }

    // Scan Layout.appsDir/*/nyx-app.json; corrupt manifests skipped with a
    // stderr note, never fatal.
    nonisolated private static func scanManifests() -> [AppManifest] {
        let fm = FileManager.default
        guard let dirs = try? fm.contentsOfDirectory(
            at: Layout.appsDir, includingPropertiesForKeys: [.isDirectoryKey]) else { return [] }
        var out: [AppManifest] = []
        for dir in dirs {
            let manifest = dir.appendingPathComponent("nyx-app.json")
            guard fm.fileExists(atPath: manifest.path),
                  let data = try? Data(contentsOf: manifest) else { continue }
            do {
                out.append(try JSONDecoder().decode(AppManifest.self, from: data))
            } catch {
                FileHandle.standardError.write(
                    Data("nyx: skipping invalid app manifest (\(dir.lastPathComponent)): \(error)\n".utf8))
            }
        }
        return out.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    // One `launchctl list` per refresh. Output rows are "pid\tstatus\tlabel";
    // pid "-" means loaded-not-running. Fixed binary, no operator-droppable
    // input reaches the command — the no-Process rule for widget sources does
    // not apply to this fixed probe.
    nonisolated private static func launchdTable() -> [String: Int?] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["list"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        do { try p.run() } catch { return [:] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard let text = String(data: data, encoding: .utf8) else { return [:] }
        var table: [String: Int?] = [:]
        for line in text.split(whereSeparator: { $0.isNewline }).dropFirst() {
            let cols = line.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
            guard cols.count == 3 else { continue }
            table[String(cols[2])] = Int(cols[0])
        }
        return table
    }

    nonisolated private static func state(for m: AppManifest, in table: [String: Int?]) -> AppRunState {
        guard m.runtimeKind == "launchagent", let label = m.runtimeLabel else { return .notApplicable }
        guard let entry = table[label] else { return .notLoaded }
        if let pid = entry { return .running(pid: pid) }
        return .loaded
    }
}

// MARK: - Views

struct AppsTab: View {
    @EnvironmentObject var store: Store
    @StateObject private var apps = AppsStore()

    private let pages = [SidebarPage("installed", "Installed", icon: "shippingbox")]

    var body: some View {
        TabShellView(pages: pages) { _ in
            content
        }
        .onAppear { apps.refresh() }
        // Re-probe on the Store cadence (15s) while the tab is visible so the
        // launchd state chips stay current without their own timer.
        .onReceive(store.$state) { _ in apps.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        if apps.entries.isEmpty {
            PlaceholderPage(
                icon: "shippingbox",
                title: apps.scannedOnce ? "No apps installed" : "Scanning…",
                message: "Drop an app folder containing nyx-app.json into ~/Nyx/Apps. The contract lives in ~/Nyx/Apps/README.md.")
        } else {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 12)],
                          alignment: .leading, spacing: 12) {
                    ForEach(apps.entries) { AppCard(entry: $0) }
                }
                .padding(.bottom, 12)
            }
        }
    }
}

struct AppCard: View {
    let entry: AppEntry

    private var m: AppManifest { entry.manifest }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: m.icon)
                    .font(.title3)
                    .frame(width: 22)
                    .foregroundStyle(.secondary)
                Text(m.title).font(.headline).lineLimit(1)
                Spacer(minLength: 0)
                stateChip
            }
            if !m.description.isEmpty {
                Text(m.description)
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                tag(m.runtimeKind)
                ForEach(m.substrate, id: \.self) { tag($0) }
                Spacer(minLength: 0)
                if !m.version.isEmpty {
                    Text("v\(m.version)").font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: 110, alignment: .topLeading)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    }

    private var stateChip: some View {
        HStack(spacing: 5) {
            Circle().fill(stateColor).frame(width: 8, height: 8)
            Text(stateLabel).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var stateColor: Color {
        switch entry.state {
        case .running:       return .green
        case .loaded:        return .yellow
        case .notLoaded:     return .gray
        case .notApplicable: return .clear
        }
    }

    private var stateLabel: String {
        switch entry.state {
        case .running(let pid): return "Running · \(pid)"
        case .loaded:           return "Loaded"
        case .notLoaded:        return "Not loaded"
        case .notApplicable:    return ""
        }
    }

    private func tag(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.quaternary, in: Capsule())
            .foregroundStyle(.secondary)
    }
}
