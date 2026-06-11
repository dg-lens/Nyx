import SwiftUI

// Premade dashboard templates. The "Add Dashboard" chooser builds a fresh
// dashboard from one of these. Each template produces a NEW id on use so multiple
// instances don't collide. The empty area for future generated role-scoped
// dashboards is rendered in the chooser sheet, not built here.
enum DashboardTemplates {
    // The default dashboard shipped pre-starred on install: a couple of live stat
    // widgets plus a welcome note. Stable id so a reseed re-creates the same home.
    static func overview() -> DashboardLayout {
        DashboardLayout(
            id: "overview",
            name: "Overview",
            icon: "square.grid.2x2",
            widgets: [
                WidgetInstance(instanceId: newInstanceId(), manifestId: "queueCount",
                               col: 0, row: 0, w: 2, h: 2, text: nil),
                WidgetInstance(instanceId: newInstanceId(), manifestId: "gatesWaiting",
                               col: 2, row: 0, w: 2, h: 2, text: nil),
                WidgetInstance(instanceId: newInstanceId(), manifestId: "lastTick",
                               col: 4, row: 0, w: 2, h: 2, text: nil),
                WidgetInstance(instanceId: newInstanceId(), manifestId: "note",
                               col: 0, row: 2, w: 3, h: 2,
                               text: "Welcome to your dashboard. Use Customize to rearrange, add, or remove widgets."),
            ])
    }

    struct Template: Identifiable {
        let id: String
        let title: String
        let blurb: String
        let icon: String
        let make: () -> DashboardLayout
    }

    static let premade: [Template] = [
        Template(id: "blank", title: "Blank", blurb: "An empty dashboard to build from scratch.",
                 icon: "square.dashed") {
            DashboardLayout(id: newDashboardId(), name: "New Dashboard",
                            icon: "square.grid.2x2", widgets: [])
        },
        Template(id: "status", title: "Status", blurb: "Live queue, gates, and last-tick at a glance.",
                 icon: "gauge.with.dots.needle.bottom.50percent") {
            DashboardLayout(id: newDashboardId(), name: "Status",
                            icon: "gauge.with.dots.needle.bottom.50percent", widgets: [
                WidgetInstance(instanceId: newInstanceId(), manifestId: "queueCount",
                               col: 0, row: 0, w: 2, h: 2, text: nil),
                WidgetInstance(instanceId: newInstanceId(), manifestId: "gatesWaiting",
                               col: 2, row: 0, w: 2, h: 2, text: nil),
                WidgetInstance(instanceId: newInstanceId(), manifestId: "lastTick",
                               col: 4, row: 0, w: 2, h: 2, text: nil),
            ])
        },
        Template(id: "notes", title: "Notes", blurb: "A pair of editable note widgets for scratch text.",
                 icon: "note.text") {
            DashboardLayout(id: newDashboardId(), name: "Notes",
                            icon: "note.text", widgets: [
                WidgetInstance(instanceId: newInstanceId(), manifestId: "note",
                               col: 0, row: 0, w: 3, h: 2, text: "First note…"),
                WidgetInstance(instanceId: newInstanceId(), manifestId: "note",
                               col: 3, row: 0, w: 3, h: 2, text: "Second note…"),
            ])
        },
    ]

    static func newDashboardId() -> String { "dash-\(UUID().uuidString.prefix(8))" }
    static func newInstanceId() -> String { "w-\(UUID().uuidString.prefix(8))" }
}

// Sheet that lets the operator pick a premade template, with a visually-distinct
// reserved area for the future role-scoped generation wave (left intentionally
// non-functional per spec).
struct AddDashboardSheet: View {
    let onPick: (DashboardLayout) -> Void
    let onCancel: () -> Void

    private let cols = [GridItem(.adaptive(minimum: 150), spacing: 12)]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Add Dashboard").font(.headline)
                Spacer()
                Button("Cancel") { onCancel() }.keyboardShortcut(.cancelAction)
            }
            .padding(12)
            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("TEMPLATES").font(.caption.bold()).foregroundStyle(.secondary)
                    LazyVGrid(columns: cols, spacing: 12) {
                        ForEach(DashboardTemplates.premade) { t in
                            templateCard(t)
                        }
                    }

                    Text("GENERATED").font(.caption.bold()).foregroundStyle(.secondary)
                    reservedArea
                }
                .padding(16)
            }
        }
        .frame(width: 520, height: 460)
    }

    private func templateCard(_ t: DashboardTemplates.Template) -> some View {
        Button {
            onPick(t.make())
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: t.icon).font(.title2).foregroundStyle(.primary)
                Text(t.title).font(.callout.bold())
                Text(t.blurb).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12)
            .frame(maxWidth: .infinity, minHeight: 110, alignment: .topLeading)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }

    // Reserved, visually-distinct placeholder for future role-scoped generation.
    private var reservedArea: some View {
        VStack(spacing: 6) {
            Image(systemName: "wand.and.stars").font(.title2).foregroundStyle(.tertiary)
            Text("Role-scoped dashboards").font(.callout).foregroundStyle(.secondary)
            Text("Generated dashboards tailored to a role land in a future wave.")
                .font(.caption).foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 96)
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                .foregroundStyle(.quaternary))
    }
}
