import Foundation
import SwiftUI

// Personal task/workflow templates. Persists to $NYX_DATA_DIR/templates.json
// (schema v1). TWO writers share this file — that contract shapes everything
// here: the ENGINE's template-composer (apps/dispatcher/src/template-composer.ts)
// APPENDS source:"ai" entries between ticks (daemon ticks are invisible to the
// desktop, so the stale window since our last read is unbounded); the DESKTOP
// MERGES-ON-SAVE — save() re-reads the disk doc first, keeps the in-memory
// version for every id it knows (renames/moves/edits win), adopts disk-only
// templates/folders unless this session deleted them, and only then writes the
// union atomically (tmp+rename). Never serialize a blind in-memory snapshot:
// it silently erases any engine append that landed after the last refresh.
// Load stays corrupt-safe (empty in-memory fallback, the corrupt file is never
// overwritten until a real user mutation reaches save()). Keep the schema in
// lockstep with the engine module, and decode forgivingly (unknown fields
// ignored, missing optionals defaulted) so an engine-written entry never
// blanks the UI.

struct TemplateFolder: Identifiable, Codable, Hashable {
    var id: String
    var name: String
    var order: Int

    init(id: String = UUID().uuidString, name: String, order: Int) {
        self.id = id
        self.name = name
        self.order = order
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        name = (try? c.decode(String.self, forKey: .name)) ?? "Untitled"
        order = (try? c.decode(Int.self, forKey: .order)) ?? 0
    }

    enum CodingKeys: String, CodingKey { case id, name, order }
}

// One stored template. `text` is the plain-language description the dispatcher
// decomposes at issue time; the structured fields mirror DispatchView's
// controls — the operator never sees or types tag syntax. `createdAt` is an
// ISO string built by the caller at mutation time. `schedule` uses the same
// strings Store.dispatch emits: "slot:N" | "every:K" | nil (standing).
// gate: stored for forward-compat; the decomposer assigns gates at issue time.
struct TaskTemplate: Identifiable, Codable, Hashable {
    var id: String
    var name: String
    var folderId: String?
    var kind: String       // "task" | "workflow"
    var text: String
    var type: String
    var model: String
    var gate: String
    var priority: String
    var repo: String?
    var schedule: String?
    var createdAt: String
    var source: String     // "manual" | "promoted" | "ai"

    init(id: String = UUID().uuidString, name: String, folderId: String? = nil,
         kind: String, text: String, type: String, model: String = "auto",
         gate: String = "none", priority: String = "normal", repo: String? = nil,
         schedule: String? = nil, createdAt: String, source: String) {
        self.id = id
        self.name = name
        self.folderId = folderId
        self.kind = kind
        self.text = text
        self.type = type
        self.model = model
        self.gate = gate
        self.priority = priority
        self.repo = repo
        self.schedule = schedule
        self.createdAt = createdAt
        self.source = source
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        name = (try? c.decode(String.self, forKey: .name)) ?? "Untitled"
        folderId = try? c.decode(String.self, forKey: .folderId)
        kind = (try? c.decode(String.self, forKey: .kind)) == "workflow" ? "workflow" : "task"
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        type = (try? c.decode(String.self, forKey: .type)) ?? (kind == "workflow" ? "pipeline" : "code")
        model = (try? c.decode(String.self, forKey: .model)) ?? "auto"
        gate = (try? c.decode(String.self, forKey: .gate)) ?? "none"
        priority = (try? c.decode(String.self, forKey: .priority)) ?? "normal"
        repo = try? c.decode(String.self, forKey: .repo)
        schedule = try? c.decode(String.self, forKey: .schedule)
        createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
        source = (try? c.decode(String.self, forKey: .source)) ?? "manual"
    }

    enum CodingKeys: String, CodingKey {
        case id, name, folderId, kind, text, type, model, gate, priority, repo, schedule, createdAt, source
    }
}

struct TemplatesDoc: Codable {
    var version: Int
    var folders: [TemplateFolder]
    var templates: [TaskTemplate]

    init(version: Int = 1, folders: [TemplateFolder] = [], templates: [TaskTemplate] = []) {
        self.version = version
        self.folders = folders
        self.templates = templates
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = (try? c.decode(Int.self, forKey: .version)) ?? 1
        folders = (try? c.decode([TemplateFolder].self, forKey: .folders)) ?? []
        templates = (try? c.decode([TaskTemplate].self, forKey: .templates)) ?? []
    }

    enum CodingKeys: String, CodingKey { case version, folders, templates }
}

@MainActor
final class TemplatesStore: ObservableObject {
    @Published var folders: [TemplateFolder] = []
    @Published var templates: [TaskTemplate] = []

    private var loadWasCorrupt = false
    private var refreshGeneration = 0
    // Ids this session deleted, kept until the deletion reaches disk. Without
    // them, merge-on-save would re-adopt a just-deleted entry from the disk doc
    // (the disk still has it until save() lands) and the delete would undo
    // itself. Cleared only on a successful write.
    private var deletedTemplateIds: Set<String> = []
    private var deletedFolderIds: Set<String> = []

    private static var docPath: URL { Layout.dataDir.appendingPathComponent("templates.json") }

    init() {
        load()
    }

    // MARK: persistence

    // Missing file => empty library, NO seed write (unlike DashboardStore there
    // is no default content worth persisting). Corrupt => empty in-memory, file
    // preserved untouched until a real user mutation calls save().
    func load() {
        guard FileManager.default.fileExists(atPath: Self.docPath.path) else { return }
        guard let data = try? Data(contentsOf: Self.docPath),
              let doc = try? JSONDecoder().decode(TemplatesDoc.self, from: data) else {
            loadWasCorrupt = true
            FileHandle.standardError.write(Data("nyx: templates.json unreadable — starting with an empty library\n".utf8))
            return
        }
        folders = doc.folders
        templates = doc.templates
    }

    // Pick up engine-written (source:"ai") entries without a relaunch. Decode
    // off the main actor and publish one batch, generation-guarded like
    // AppsStore.refresh; a corrupt/missing file is a no-op (never blank a
    // working in-memory library on a transient read failure). save() also
    // bumps the generation, so a refresh that decoded a pre-save doc can never
    // land afterwards and revert the published state. Every user mutation
    // saves immediately (merge-on-save), so in-memory == disk except for
    // engine appends — assigning the freshly-decoded doc cannot lose local
    // edits.
    func refreshFromDisk() {
        refreshGeneration += 1
        let gen = refreshGeneration
        let path = Self.docPath
        Task.detached(priority: .utility) {
            guard let data = try? Data(contentsOf: path),
                  let doc = try? JSONDecoder().decode(TemplatesDoc.self, from: data) else { return }
            await MainActor.run { [weak self] in
                guard let self, gen == self.refreshGeneration else { return }
                self.folders = doc.folders
                self.templates = doc.templates
            }
        }
    }

    // Merge-on-save (the two-writer contract, see the header): re-read the disk
    // doc, write the union. In-memory wins for every id it knows (renames/moves/
    // edits); disk-only entries — engine compose_template appends since our last
    // refresh — are adopted UNLESS this session deleted them. The write itself
    // stays atomic (tmp+rename). Only reached via user mutations, so a corrupt
    // prior load is never overwritten until the operator actually changes
    // something — and a corrupt/missing disk doc here just skips the merge.
    func save() {
        loadWasCorrupt = false
        // Invalidate any in-flight refreshFromDisk: it decoded a doc that
        // predates this save and would revert the published state if it landed.
        refreshGeneration += 1
        mergeFromDisk()
        let doc = TemplatesDoc(version: 1, folders: folders, templates: templates)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? enc.encode(doc) else { return }
        let dir = Self.docPath.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let tmp = dir.appendingPathComponent("templates.json.tmp")
        do {
            try data.write(to: tmp)
            if FileManager.default.fileExists(atPath: Self.docPath.path) {
                _ = try FileManager.default.replaceItemAt(Self.docPath, withItemAt: tmp)
            } else {
                try FileManager.default.moveItem(at: tmp, to: Self.docPath)
            }
            deletedTemplateIds.removeAll()
            deletedFolderIds.removeAll()
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            FileHandle.standardError.write(Data("nyx: failed to write templates.json: \(error)\n".utf8))
        }
    }

    // The union step of save(): adopt disk-only templates/folders into the
    // in-memory (about-to-be-written) state. Ids in the deleted sets stay
    // deleted; ids we know keep their in-memory version.
    private func mergeFromDisk() {
        guard let data = try? Data(contentsOf: Self.docPath),
              let disk = try? JSONDecoder().decode(TemplatesDoc.self, from: data) else { return }
        let knownTemplateIds = Set(templates.map(\.id))
        for t in disk.templates where !knownTemplateIds.contains(t.id) && !deletedTemplateIds.contains(t.id) {
            templates.append(t)
        }
        let knownFolderIds = Set(folders.map(\.id))
        for f in disk.folders where !knownFolderIds.contains(f.id) && !deletedFolderIds.contains(f.id) {
            folders.append(f)
        }
    }

    // MARK: grouping

    // Folders in order (empty ones included so Manage can rename/delete them),
    // ungrouped last. Templates whose folderId points at a deleted folder are
    // treated as ungrouped rather than dropped.
    var grouped: [(folder: TemplateFolder?, items: [TaskTemplate])] {
        let orderedFolders = folders.sorted { ($0.order, $0.name) < ($1.order, $1.name) }
        var out: [(TemplateFolder?, [TaskTemplate])] = orderedFolders.map { f in
            (f, templates.filter { $0.folderId == f.id }.sorted { $0.name < $1.name })
        }
        let folderIds = Set(folders.map(\.id))
        let ungrouped = templates
            .filter { $0.folderId == nil || !folderIds.contains($0.folderId ?? "") }
            .sorted { $0.name < $1.name }
        out.append((nil, ungrouped))
        return out
    }

    func templates(ofKind kind: String) -> [TaskTemplate] {
        templates.filter { $0.kind == kind }
    }

    func template(_ id: String) -> TaskTemplate? {
        templates.first { $0.id == id }
    }

    // MARK: template mutations (each persists)

    func addTemplate(_ t: TaskTemplate) {
        templates.append(t)
        save()
    }

    func renameTemplate(_ id: String, to name: String) {
        guard let idx = templates.firstIndex(where: { $0.id == id }) else { return }
        templates[idx].name = name
        save()
    }

    func moveTemplate(_ id: String, toFolder folderId: String?) {
        guard let idx = templates.firstIndex(where: { $0.id == id }) else { return }
        templates[idx].folderId = folderId
        save()
    }

    func deleteTemplate(_ id: String) {
        deletedTemplateIds.insert(id)
        templates.removeAll { $0.id == id }
        save()
    }

    func duplicateTemplate(_ id: String, createdAt: String) {
        guard let src = template(id) else { return }
        var copy = src
        copy.id = UUID().uuidString
        copy.name = "\(src.name) copy"
        copy.createdAt = createdAt
        templates.append(copy)
        save()
    }

    // MARK: folder mutations (each persists)

    func createFolder(named name: String) {
        let order = (folders.map(\.order).max() ?? -1) + 1
        folders.append(TemplateFolder(name: name, order: order))
        save()
    }

    func renameFolder(_ id: String, to name: String) {
        guard let idx = folders.firstIndex(where: { $0.id == id }) else { return }
        folders[idx].name = name
        save()
    }

    // Deleting a folder never deletes its templates — they fall back ungrouped.
    func deleteFolder(_ id: String) {
        deletedFolderIds.insert(id)
        folders.removeAll { $0.id == id }
        for idx in templates.indices where templates[idx].folderId == id {
            templates[idx].folderId = nil
        }
        save()
    }
}
