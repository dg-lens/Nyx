import SwiftUI

// Create Templates page — two ways to build a template:
//   (a) Manual: a form mirroring DispatchView's controls that writes the
//       STRUCTURED fields straight into TemplatesStore — the operator never
//       sees or types tag syntax; tags are rebuilt at issue time from the
//       stored fields.
//   (b) Claude-drafted: a prompt + "Draft with Claude" that enqueues a
//       `compose_template` control action through the same Database.enqueueAction
//       path the dispatch flow uses. The dispatcher's template-composer spawn
//       (apps/dispatcher/src/template-composer.ts) validates the draft and
//       appends it to templates.json with source:"ai" on the next tick;
//       refreshFromDisk picks it up here.
struct CreateTemplatesView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var templates: TemplatesStore

    // Manual form state. kind drives the type rules: workflow templates are
    // always type "pipeline" (the only type the pipeline orchestrator runs).
    @State private var name = ""
    @State private var folderId: String? = nil
    @State private var kind = "task"
    @State private var text = ""
    @State private var type = "code"
    @State private var model = "auto"
    @State private var priority = "normal"
    @State private var repo = ""
    @State private var schedule = "standing"
    @State private var atTime = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var recurEvery = "6h"
    @State private var savedNote = ""

    // Claude-drafted state.
    @State private var draftPrompt = ""
    @State private var draftKind = "task"
    @State private var draftStatus = ""

    private let taskTypes = ["code", "analysis", "assistant", "content"]
    private let priorities = ["high", "normal", "low"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                manualSection
                Divider()
                draftSection
            }
            .padding(16)
        }
        .onAppear { templates.refreshFromDisk() }
        // A finished tick may have applied a pending compose_template — re-read
        // the library so the drafted template shows up without a relaunch.
        .onChange(of: store.ticking) { ticking in
            if !ticking { templates.refreshFromDisk() }
        }
    }

    // ─── (a) Manual ───────────────────────────────────────────────────────────

    private var manualSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Build a template").font(.headline)
            Text("Fill the same fields the + add-flow editor uses. Saved templates re-issue in one click.")
                .font(.caption).foregroundStyle(.secondary)

            HStack(alignment: .bottom, spacing: 14) {
                labeled("Name") {
                    TextField("Template name", text: $name)
                        .textFieldStyle(.roundedBorder).frame(width: 220)
                }
                labeled("Folder") {
                    Picker("", selection: $folderId) {
                        Text("Ungrouped").tag(String?.none)
                        ForEach(templates.folders.sorted(by: { ($0.order, $0.name) < ($1.order, $1.name) })) { f in
                            Text(f.name).tag(String?.some(f.id))
                        }
                    }
                    .labelsHidden().fixedSize()
                }
                labeled("Kind") {
                    Picker("", selection: $kind) {
                        Label("task", systemImage: AddKind.task.icon).tag("task")
                        Label("workflow", systemImage: AddKind.workflow.icon).tag("workflow")
                    }
                    .labelsHidden().fixedSize()
                    .onChange(of: kind) { k in
                        if k == "workflow" { type = "pipeline" }
                        else if type == "pipeline" { type = "code" }
                    }
                }
                Spacer()
            }

            TextEditor(text: $text)
                .font(.body)
                .frame(minHeight: 90)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))

            HStack(alignment: .bottom, spacing: 14) {
                labeled("Type") {
                    Picker("", selection: $type) {
                        if kind == "workflow" {
                            Text("pipeline").tag("pipeline")
                        } else {
                            ForEach(taskTypes, id: \.self) { Text($0) }
                        }
                    }
                    .labelsHidden().fixedSize()
                    .disabled(kind == "workflow")
                }
                labeled("Model") {
                    Picker("", selection: $model) {
                        Text("Auto-Detect").tag("auto")
                        Text("haiku").tag("haiku")
                        Text("sonnet").tag("sonnet")
                        Text("opus").tag("opus")
                    }
                    .labelsHidden().fixedSize()
                }
                labeled("Priority") {
                    Picker("", selection: $priority) { ForEach(priorities, id: \.self) { Text($0) } }
                        .labelsHidden().fixedSize()
                }
                Spacer()
            }

            HStack(alignment: .bottom, spacing: 14) {
                labeled("Schedule") {
                    Picker("", selection: $schedule) {
                        Text("Standing").tag("standing")
                        Text("Daily at time").tag("atTime")
                        Text("Recurring").tag("recurring")
                    }.labelsHidden().fixedSize()
                }
                if schedule == "atTime" {
                    labeled("Time of day") {
                        DatePicker("", selection: $atTime, displayedComponents: .hourAndMinute)
                            .labelsHidden()
                    }
                } else if schedule == "recurring" {
                    labeled("Every") {
                        Picker("", selection: $recurEvery) {
                            Text("3 hours").tag("3h")
                            Text("6 hours").tag("6h")
                            Text("12 hours").tag("12h")
                            Text("Daily").tag("24h")
                            Text("Weekly").tag("7d")
                        }.labelsHidden().fixedSize()
                    }
                }
                labeled("Repo (optional)") {
                    TextField("org/name", text: $repo)
                        .textFieldStyle(.roundedBorder).frame(width: 200)
                }
                Spacer()
                Button {
                    saveManual()
                } label: {
                    Label("Save template", systemImage: "folder.badge.plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty
                          || text.trimmingCharacters(in: .whitespaces).isEmpty)
            }

            if !savedNote.isEmpty {
                Text(savedNote).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    // Same slot math as DispatchView.scheduleString — the stored string is what
    // Store.dispatch forwards verbatim at issue time.
    private var scheduleString: String? {
        switch schedule {
        case "atTime":
            let c = Calendar.current.dateComponents([.hour, .minute], from: atTime)
            let slot = (c.hour ?? 0) * 12 + (c.minute ?? 0) / 5
            return "slot:\(slot)"
        case "recurring":
            return "every:\(recurEvery)"
        default:
            return nil
        }
    }

    private func saveManual() {
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, !trimmedText.isEmpty else { return }
        templates.addTemplate(TaskTemplate(
            name: trimmedName,
            folderId: folderId,
            kind: kind,
            text: trimmedText,
            type: kind == "workflow" ? "pipeline" : type,
            model: model,
            // No Gate UI — gates are the decomposer's call at issue time; the
            // stored field is forward-compat only (see TemplatesStore schema).
            gate: kind != "workflow" && type == "code" ? "typecheck,tests" : "none",
            priority: priority,
            repo: repo.isEmpty ? nil : repo,
            schedule: scheduleString,
            createdAt: ManageTemplatesView.nowIso(),
            source: "manual"))
        savedNote = "Saved \"\(trimmedName)\" — it's in Manage Templates and the + add-flow."
        name = ""
        text = ""
    }

    // ─── (b) Claude-drafted ───────────────────────────────────────────────────

    private var draftSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Draft with Claude").font(.headline)
            Text("Describe the template in plain language. The dispatcher drafts the full spec on its next tick and saves it to your library (source: ai).")
                .font(.caption).foregroundStyle(.secondary)

            TextEditor(text: $draftPrompt)
                .font(.body)
                .frame(minHeight: 80)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))

            HStack(alignment: .bottom, spacing: 14) {
                labeled("Kind") {
                    Picker("", selection: $draftKind) {
                        Label("task", systemImage: AddKind.task.icon).tag("task")
                        Label("workflow", systemImage: AddKind.workflow.icon).tag("workflow")
                    }
                    .labelsHidden().fixedSize()
                }
                Spacer()
                Button {
                    enqueueDraft()
                } label: {
                    Label("Draft with Claude", systemImage: "wand.and.stars")
                }
                .buttonStyle(.borderedProminent)
                .disabled(draftPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if !draftStatus.isEmpty {
                Text(draftStatus).font(.caption).foregroundStyle(.secondary)
            }

            if !aiTemplates.isEmpty {
                Text("Recently drafted").font(.caption.bold()).foregroundStyle(.secondary)
                ForEach(aiTemplates) { t in
                    HStack(spacing: 8) {
                        Image(systemName: t.kind == "workflow" ? AddKind.workflow.icon : AddKind.task.icon)
                            .foregroundStyle(t.kind == "workflow" ? AddKind.workflow.tint : AddKind.task.tint)
                            .frame(width: 16)
                        Text(t.name).font(.callout)
                        Spacer(minLength: 0)
                        Text(t.type).font(.caption2)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(TaskPalette.color(t.type).opacity(0.15), in: Capsule())
                            .foregroundStyle(TaskPalette.color(t.type))
                    }
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
                }
            }
        }
    }

    private var aiTemplates: [TaskTemplate] {
        templates.templates
            .filter { $0.source == "ai" }
            .sorted { $0.createdAt > $1.createdAt }
            .prefix(5)
            .map { $0 }
    }

    // Same control-surface write the dispatch flow uses (Database.enqueueAction
    // + a tick), with the compose_template action the engine drains in
    // processComposeTemplateActions.
    private func enqueueDraft() {
        let prompt = draftPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        let ok = Database.enqueueAction("compose_template", params: ["prompt": prompt, "kind": draftKind])
        if ok {
            draftStatus = "Drafting via the dispatcher — the template appears here after the next tick."
            draftPrompt = ""
            store.runTick()
        } else {
            draftStatus = "Failed to enqueue (DB busy). Try again."
        }
    }

    @ViewBuilder
    private func labeled<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            content()
        }
    }
}
