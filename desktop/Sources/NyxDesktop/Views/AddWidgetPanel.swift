import SwiftUI

// Right-side vertical panel listing plugins as collapsed DisclosureGroups of their
// available widgets. Clicking a widget adds it to the first free space on the grid.
struct AddWidgetPanel: View {
    let store: DashboardStore
    let onAdd: (WidgetManifest, Int) -> Void
    let onClose: () -> Void
    let gridCols: Int

    @State private var expanded: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Add Widget").font(.callout.bold())
                Spacer()
                Button { onClose() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
            }
            .padding(12)
            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(store.manifestsByPlugin, id: \.plugin) { group in
                        pluginSection(group.plugin, group.items)
                    }
                }
                .padding(10)
            }
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary, lineWidth: 1))
        .padding(8)
    }

    private func pluginSection(_ plugin: String, _ items: [WidgetManifest]) -> some View {
        DisclosureGroup(isExpanded: Binding(
            get: { expanded.contains(plugin) },
            set: { if $0 { expanded.insert(plugin) } else { expanded.remove(plugin) } })) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items) { m in
                    widgetRow(m)
                }
            }
            .padding(.top, 4)
        } label: {
            Text(pluginLabel(plugin)).font(.caption.bold()).foregroundStyle(.secondary)
        }
    }

    // Human plugin label: hyphenated ids like "nyx-ops" read as "Nyx Ops".
    private func pluginLabel(_ plugin: String) -> String {
        plugin.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
    }

    private func rowIcon(_ viz: String) -> String {
        switch viz {
        case "stat":   return "number.square"
        case "status": return "circle.dashed"
        default:       return "text.alignleft"
        }
    }

    private func widgetRow(_ m: WidgetManifest) -> some View {
        Button {
            onAdd(m, gridCols)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: rowIcon(m.viz))
                    .foregroundStyle(.secondary).frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(m.title).font(.callout)
                    if let d = m.description {
                        Text(d).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "plus.circle").foregroundStyle(.blue)
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }
}
