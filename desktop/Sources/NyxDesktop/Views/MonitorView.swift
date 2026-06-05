import SwiftUI

struct MonitorView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            panel("Queue") {
                if store.state.queue.isEmpty {
                    Text("queue empty").font(.caption).foregroundStyle(.tertiary)
                } else {
                    ForEach(store.state.queue) { q in
                        VStack(alignment: .leading, spacing: 1) {
                            Text("\(q.id)\(q.title.isEmpty ? "" : " — \(q.title)")").font(.callout)
                            Text(q.type).font(.caption2).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Divider()
                    }
                }
            }
            panel("Recent audit") {
                if store.state.audit.isEmpty {
                    Text("no recent events").font(.caption).foregroundStyle(.tertiary)
                } else {
                    ForEach(store.state.audit) { a in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(a.event).font(.callout)
                            Text("\(a.at)\(a.detail.isEmpty ? "" : " · \(a.detail)")")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Divider()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func panel<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(.caption.bold()).foregroundStyle(.secondary)
            ScrollView { VStack(alignment: .leading, spacing: 6) { content() } }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    }
}
