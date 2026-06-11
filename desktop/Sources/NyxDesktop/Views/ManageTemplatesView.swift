import SwiftUI

// Manage Templates page: the personal template library, folder-grouped
// (ungrouped last), with per-template actions (rename / move-to-folder /
// duplicate / delete-with-confirm), folder actions (create / rename /
// delete — templates fall back ungrouped), and a "Promote a recent task"
// affordance that saves one of the last-10 recents as a template. All
// mutations go through TemplatesStore (atomic, corrupt-safe persistence);
// recents come from RecentTasks (nyx.md parse, off the main actor).
struct ManageTemplatesView: View {
    @EnvironmentObject var templates: TemplatesStore

    @State private var recents: [RecentTask] = []
    // Sheet/dialog drivers. One at a time; each holds the subject it acts on.
    @State private var renamingTemplate: TaskTemplate? = nil
    @State private var deletingTemplate: TaskTemplate? = nil
    @State private var renamingFolder: TemplateFolder? = nil
    @State private var deletingFolder: TemplateFolder? = nil
    @State private var promoting: RecentTask? = nil
    @State private var creatingFolder = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                libraryHeader
                if templates.templates.isEmpty {
                    PlaceholderPage(
                        icon: "folder",
                        title: "No templates yet",
                        message: "Templates are reusable task/workflow specs you re-issue in one click from the + add-flow. Build one on the Create Templates page, or promote a recent task below.")
                        .frame(minHeight: 200)
                } else {
                    library
                }
                Divider()
                promoteSection
            }
            .padding(16)
        }
        // Pick up engine-written (Claude-drafted) templates on entry.
        .onAppear { templates.refreshFromDisk() }
        .task { recents = await RecentTasks.fetch(limit: 10) }
        .sheet(item: $renamingTemplate) { t in
            NameSheet(title: "Rename template", initial: t.name) { name in
                templates.renameTemplate(t.id, to: name)
            }
        }
        .sheet(item: $renamingFolder) { f in
            NameSheet(title: "Rename folder", initial: f.name) { name in
                templates.renameFolder(f.id, to: name)
            }
        }
        .sheet(isPresented: $creatingFolder) {
            NameSheet(title: "New folder", initial: "") { name in
                templates.createFolder(named: name)
            }
        }
        .sheet(item: $promoting) { r in
            PromoteSheet(recent: r)
        }
        .confirmationDialog(
            "Delete \"\(deletingTemplate?.name ?? "")\"?",
            isPresented: Binding(get: { deletingTemplate != nil },
                                 set: { if !$0 { deletingTemplate = nil } })) {
            Button("Delete template", role: .destructive) {
                if let t = deletingTemplate { templates.deleteTemplate(t.id) }
                deletingTemplate = nil
            }
        } message: {
            Text("This removes the template from your library. Queued tasks are unaffected.")
        }
        .confirmationDialog(
            "Delete folder \"\(deletingFolder?.name ?? "")\"?",
            isPresented: Binding(get: { deletingFolder != nil },
                                 set: { if !$0 { deletingFolder = nil } })) {
            Button("Delete folder", role: .destructive) {
                if let f = deletingFolder { templates.deleteFolder(f.id) }
                deletingFolder = nil
            }
        } message: {
            Text("Its templates are kept and move to Ungrouped.")
        }
    }

    private var libraryHeader: some View {
        HStack {
            Text("Template library").font(.headline)
            Spacer()
            Button { creatingFolder = true } label: {
                Label("New folder", systemImage: "folder.badge.plus")
            }
        }
    }

    // Folder sections in order, ungrouped last (TemplatesStore.grouped). Empty
    // named folders still render so they can be renamed/deleted; the ungrouped
    // section hides when empty.
    private var library: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(templates.grouped, id: \.folder?.id) { group in
                if group.folder != nil || !group.items.isEmpty {
                    folderSection(group.folder, group.items)
                }
            }
        }
    }

    @ViewBuilder
    private func folderSection(_ folder: TemplateFolder?, _ items: [TaskTemplate]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "folder").foregroundStyle(.secondary).font(.caption)
                Text(folder?.name ?? "Ungrouped").font(.caption.bold()).foregroundStyle(.secondary)
                Spacer()
                if let folder {
                    Button { renamingFolder = folder } label: { Image(systemName: "pencil") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                        .help("Rename folder")
                    Button { deletingFolder = folder } label: { Image(systemName: "trash") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                        .help("Delete folder (templates move to Ungrouped)")
                }
            }
            if items.isEmpty {
                Text("Empty").font(.caption2).foregroundStyle(.tertiary).padding(.leading, 20)
            } else {
                ForEach(items) { t in
                    templateRow(t)
                }
            }
        }
    }

    private func templateRow(_ t: TaskTemplate) -> some View {
        HStack(spacing: 8) {
            Image(systemName: t.kind == "workflow" ? AddKind.workflow.icon : AddKind.task.icon)
                .foregroundStyle(t.kind == "workflow" ? AddKind.workflow.tint : AddKind.task.tint)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(t.name).font(.callout)
                Text(t.text).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Text(t.type).font(.caption2)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(TaskPalette.color(t.type).opacity(0.15), in: Capsule())
                .foregroundStyle(TaskPalette.color(t.type))
            if t.source != "manual" {
                Text(t.source).font(.caption2).foregroundStyle(.tertiary)
            }
            Menu {
                Button("Rename…") { renamingTemplate = t }
                moveMenu(t)
                Button("Duplicate") {
                    templates.duplicateTemplate(t.id, createdAt: Self.nowIso())
                }
                Divider()
                Button("Delete…", role: .destructive) { deletingTemplate = t }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    }

    private func moveMenu(_ t: TaskTemplate) -> some View {
        Menu("Move to folder") {
            Button("Ungrouped") { templates.moveTemplate(t.id, toFolder: nil) }
            ForEach(templates.folders.sorted(by: { ($0.order, $0.name) < ($1.order, $1.name) })) { f in
                Button(f.name) { templates.moveTemplate(t.id, toFolder: f.id) }
            }
        }
    }

    // ─── Promote a recent task ────────────────────────────────────────────────

    private var promoteSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Promote a recent task").font(.headline)
            Text("Save one of the last 10 issued tasks as a reusable template.")
                .font(.caption).foregroundStyle(.secondary)
            if recents.isEmpty {
                Text("No recent tasks found in the queue file.")
                    .font(.caption).foregroundStyle(.tertiary)
            } else {
                ForEach(recents) { r in
                    recentRow(r)
                }
            }
        }
    }

    private func recentRow(_ r: RecentTask) -> some View {
        HStack(spacing: 8) {
            Image(systemName: r.kind == "workflow" ? AddKind.workflow.icon : AddKind.task.icon)
                .foregroundStyle(.secondary).frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(r.id).font(.callout)
                Text(r.title).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Text(r.type).font(.caption2)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(TaskPalette.color(r.type).opacity(0.15), in: Capsule())
                .foregroundStyle(TaskPalette.color(r.type))
            Button("Save as template…") { promoting = r }
                .controlSize(.small)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    }

    static func nowIso() -> String {
        ISO8601DateFormatter().string(from: Date())
    }
}

// ─── Small shared sheets ──────────────────────────────────────────────────────

// One-field name prompt for rename/create. Commit on Save or Return; Cancel
// discards. Kept tiny on purpose — no validation beyond non-empty.
private struct NameSheet: View {
    let title: String
    let initial: String
    let onCommit: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            TextField("Name", text: $name)
                .textFieldStyle(.roundedBorder)
                .frame(width: 280)
                .onSubmit { commit() }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") { commit() }
                    .buttonStyle(.borderedProminent)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(16)
        .onAppear { name = initial }
    }

    private func commit() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        onCommit(trimmed)
        dismiss()
    }
}

// Name + folder picker for promoting a recent task into the library. The
// recovered spec fields ride along verbatim; source is "promoted".
private struct PromoteSheet: View {
    let recent: RecentTask
    @EnvironmentObject var templates: TemplatesStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var folderId: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Save as template").font(.headline)
            Text(recent.title.isEmpty ? recent.id : recent.title)
                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
            TextField("Template name", text: $name)
                .textFieldStyle(.roundedBorder)
                .frame(width: 300)
            Picker("Folder", selection: $folderId) {
                Text("Ungrouped").tag(String?.none)
                ForEach(templates.folders.sorted(by: { ($0.order, $0.name) < ($1.order, $1.name) })) { f in
                    Text(f.name).tag(String?.some(f.id))
                }
            }
            .frame(width: 300)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") { save() }
                    .buttonStyle(.borderedProminent)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(16)
        .onAppear { name = recent.title.isEmpty ? recent.id : recent.title }
    }

    private func save() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        templates.addTemplate(TaskTemplate(
            name: trimmed,
            folderId: folderId,
            kind: recent.kind,
            text: recent.text,
            type: AddFlowDispatch.validTypes.contains(recent.type) ? recent.type : "assistant",
            model: recent.model ?? "auto",
            gate: recent.gate ?? (recent.type == "code" ? "typecheck,tests" : "none"),
            priority: recent.priority,
            repo: recent.repo,
            schedule: recent.schedule,
            createdAt: ManageTemplatesView.nowIso(),
            source: "promoted"))
        dismiss()
    }
}
