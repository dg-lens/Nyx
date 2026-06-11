import Foundation
import SwiftUI

// Owns the dashboards list, the starred (primary/home) id, and the manifest
// registry. Persists to $NYX_DATA_DIR/dashboards.json with an atomic tmp+rename
// write. Loads gracefully on missing/corrupt — falls back to the default Overview
// without crashing and NEVER overwrites a corrupt file until the user changes
// something (a corrupt load sets `loadWasCorrupt`, and save() is gated on a real
// user mutation, so the bad file is preserved for inspection).
@MainActor
final class DashboardStore: ObservableObject {
    @Published var dashboards: [DashboardLayout] = []
    @Published var starredId: String = ""
    @Published private(set) var manifests: [String: WidgetManifest] = [:]
    // Resolved status-widget payloads, keyed by manifest id. Refreshed on the
    // Store refresh cadence (not per render) — StatusResolver does file IO, and
    // resolving inside a view body re-reads disk ~1×/sec under the countdown
    // timer's invalidation. WidgetView only ever reads this cache.
    @Published private(set) var statusPayloads: [String: StatusPayload] = [:]

    private var loadWasCorrupt = false
    private var pendingSave: Task<Void, Never>?
    private var statusGeneration = 0

    private static var docPath: URL { Layout.dataDir.appendingPathComponent("dashboards.json") }

    init() {
        manifests = WidgetManifestLoader.loadAll()
        load()
    }

    // Re-scan the Data-dir for newly-dropped manifests (called on app refresh).
    func reloadManifests() {
        manifests = WidgetManifestLoader.loadAll()
    }

    // Resolve every status-viz manifest off the main actor and publish the
    // results in one batch. Resolves ALL loaded status manifests (not just
    // placed instances) so a freshly-added widget has data immediately; the
    // set is a handful of small files, so the cost is trivial at this cadence.
    func refreshStatusPayloads(_ state: NyxState) {
        let sources = manifests.values
            .filter { $0.viz == "status" }
            .map { (id: $0.id, source: $0.source) }
        guard !sources.isEmpty else { return }
        // Generation guard: launch fires several refreshes near-simultaneously
        // (onAppear with empty state, the subscription's immediate emit, the
        // first real refresh). Detached resolves complete unordered, so only
        // the newest request may publish — else an empty-state snapshot can
        // overwrite real data until the next cadence tick.
        statusGeneration += 1
        let gen = statusGeneration
        Task.detached(priority: .utility) {
            var resolved: [String: StatusPayload] = [:]
            for s in sources {
                resolved[s.id] = StatusResolver.resolve(s.source, state)
            }
            let result = resolved
            await MainActor.run { [weak self] in
                guard let self, gen == self.statusGeneration else { return }
                self.statusPayloads = result
            }
        }
    }

    var starred: DashboardLayout? {
        dashboards.first { $0.id == starredId } ?? dashboards.first
    }

    func manifest(_ id: String) -> WidgetManifest? { manifests[id] }

    // Manifests grouped by pluginId for the add-widget panel (DisclosureGroups).
    var manifestsByPlugin: [(plugin: String, items: [WidgetManifest])] {
        Dictionary(grouping: manifests.values, by: { $0.pluginId })
            .map { (plugin: $0.key, items: $0.value.sorted { $0.title < $1.title }) }
            .sorted { $0.plugin < $1.plugin }
    }

    // MARK: persistence

    func load() {
        guard FileManager.default.fileExists(atPath: Self.docPath.path) else {
            seedDefault()
            return
        }
        guard let data = try? Data(contentsOf: Self.docPath) else {
            loadWasCorrupt = true
            seedDefault(persist: false)
            return
        }
        guard let doc = try? JSONDecoder().decode(DashboardDoc.self, from: data),
              !doc.dashboards.isEmpty else {
            // Corrupt or empty: fall back to default Overview in-memory but do NOT
            // overwrite the file — preserve it until a real user change.
            loadWasCorrupt = true
            FileHandle.standardError.write(Data("nyx: dashboards.json unreadable — using default Overview\n".utf8))
            seedDefault(persist: false)
            return
        }
        dashboards = doc.dashboards
        starredId = doc.dashboards.contains { $0.id == doc.starredId }
            ? doc.starredId
            : (doc.dashboards.first?.id ?? "")
    }

    private func seedDefault(persist: Bool = true) {
        let overview = DashboardTemplates.overview()
        dashboards = [overview]
        starredId = overview.id
        if persist { save() }
    }

    // Atomic write: serialize to a tmp file, then rename over the target. A corrupt
    // prior load won't be overwritten unless this is reached via a user mutation.
    func save() {
        pendingSave?.cancel()
        pendingSave = nil
        loadWasCorrupt = false
        let doc = DashboardDoc(version: 1, starredId: starredId, dashboards: dashboards)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? enc.encode(doc) else { return }
        let dir = Self.docPath.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let tmp = dir.appendingPathComponent("dashboards.json.tmp")
        do {
            try data.write(to: tmp)
            if FileManager.default.fileExists(atPath: Self.docPath.path) {
                _ = try FileManager.default.replaceItemAt(Self.docPath, withItemAt: tmp)
            } else {
                try FileManager.default.moveItem(at: tmp, to: Self.docPath)
            }
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            FileHandle.standardError.write(Data("nyx: failed to write dashboards.json: \(error)\n".utf8))
        }
    }

    // MARK: mutations (each persists)

    func star(_ id: String) {
        guard dashboards.contains(where: { $0.id == id }) else { return }
        starredId = id
        save()
    }

    func addDashboard(_ layout: DashboardLayout) {
        dashboards.append(layout)
        save()
    }

    func updateDashboard(_ layout: DashboardLayout) {
        guard let idx = dashboards.firstIndex(where: { $0.id == layout.id }) else { return }
        dashboards[idx] = layout
        save()
    }

    // Keystroke-cadence mutations (the note widget's TextEditor): publish the
    // in-memory change immediately, but coalesce the disk write — save() per
    // keypress writes dashboards.json on every character. Any structural
    // mutation's immediate save() supersedes a pending one (it persists the
    // same up-to-date doc), so the pending task is simply cancelled there.
    func updateDashboardDebounced(_ layout: DashboardLayout) {
        guard let idx = dashboards.firstIndex(where: { $0.id == layout.id }) else { return }
        dashboards[idx] = layout
        pendingSave?.cancel()
        // Strong self on purpose: this store is a @StateObject that deallocates
        // when its tab leaves the hierarchy. A weak capture would drop the final
        // flush on tab switch — and trailing-edge debounce means a continuous
        // typing burst would never have saved at all. The task holds the store
        // ≤800ms; no cycle survives past completion.
        pendingSave = Task {
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            self.pendingSave = nil
            self.save()
        }
    }

    func removeDashboard(_ id: String) {
        dashboards.removeAll { $0.id == id }
        if starredId == id { starredId = dashboards.first?.id ?? "" }
        if dashboards.isEmpty { seedDefault(persist: false) }
        save()
    }
}
