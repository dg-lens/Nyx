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
                    let groups = AuditGroup.group(store.state.audit)
                    ForEach(groups) { SubjectBubble(group: $0) }
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

// MARK: - Status derivation

enum AuditStatus {
    case completed, failed, error, working, started, system

    var label: String {
        switch self {
        case .completed: return "Completed"
        case .failed:    return "Failed"
        case .error:     return "Error"
        case .working:   return "Working"
        case .started:   return "Started"
        case .system:    return "System"
        }
    }

    var color: Color {
        switch self {
        case .completed: return .green
        case .failed:    return .red
        case .error:     return .orange
        case .working:   return .blue
        case .started, .system: return .gray
        }
    }
}

// MARK: - Grouping

// One AuditGroup == one subject (task/run) or the catch-all System bucket. Rows are
// held newest-first (the audit query already returns DESC by id).
struct AuditGroup: Identifiable {
    let id: String          // subjectId, or the sentinel "__system__"
    let rows: [AuditRow]
    let isSystem: Bool

    var status: AuditStatus { isSystem ? .system : AuditGroup.derive(rows) }

    // A short human phrase from the latest meaningful event in this subject's history.
    var phrase: String {
        for r in rows {
            let p = AuditGroup.phrase(for: r)
            if !p.isEmpty { return p }
        }
        return rows.first.map(AuditGroup.eventLabel) ?? ""
    }

    static func group(_ audit: [AuditRow]) -> [AuditGroup] {
        var order: [String] = []
        var byId: [String: [AuditRow]] = [:]
        var system: [AuditRow] = []
        for row in audit {
            guard let sid = row.subjectId, !sid.isEmpty else { system.append(row); continue }
            if byId[sid] == nil { order.append(sid) }
            byId[sid, default: []].append(row)
        }
        var groups = order.map { AuditGroup(id: $0, rows: byId[$0] ?? [], isSystem: false) }
        if !system.isEmpty {
            groups.append(AuditGroup(id: "__system__", rows: system, isSystem: true))
        }
        return groups
    }

    // Status from the subject's events, newest wins. rows is newest-first, so the
    // FIRST match walking forward is the most recent classification.
    static func derive(_ rows: [AuditRow]) -> AuditStatus {
        var sawError = false
        var sawWorking = false
        var sawStarted = false
        for r in rows {
            let e = r.event
            if e == "task.completed" || e == "pipeline.delivered" {
                return .completed
            }
            if e == "task.halted_for_review" || e == "task.abandoned"
                || e == "pipeline.failed" || e == "pipeline.aborted" {
                return .failed
            }
            if e == "task.failed" || e.hasPrefix("task.audit.") {
                sawError = true
            }
            if e == "task.started" {
                sawStarted = true
            }
            if isIntermediate(e) {
                sawWorking = true
            }
        }
        // No terminal/recovery row seen above — fall through by precedence.
        if sawError { return .error }
        if sawWorking && sawStarted { return .working }
        if sawStarted { return .started }
        // Subject with intermediate events but no explicit start row still reads as
        // in-flight rather than unknown.
        if sawWorking { return .working }
        return .started
    }

    private static func isIntermediate(_ e: String) -> Bool {
        e.contains(".gate") || e.contains(".judge") || e.contains("normalize")
            || e.contains(".wisdom") || e.contains(".commit") || e == "task.committed"
            || e.contains(".push") || e == "task.pushed"
            || e == "pipeline.gateReached" || e.contains("gateReached")
    }

    private static func phrase(for r: AuditRow) -> String {
        if !r.detail.isEmpty { return "\(eventLabel(r)) · \(r.detail)" }
        return eventLabel(r)
    }

    // "task.gate.completed" -> "gate completed"; drops the leading namespace.
    static func eventLabel(_ r: AuditRow) -> String {
        let parts = r.event.split(separator: ".").map(String.init)
        let tail = parts.count > 1 ? parts.dropFirst() : parts[...]
        return tail.joined(separator: " ")
    }
}

// MARK: - Bubble

struct SubjectBubble: View {
    let group: AuditGroup
    @State private var expanded: Bool

    init(group: AuditGroup) {
        self.group = group
        // System bubble collapsed by default; subject bubbles expanded so the
        // status phrase reads without a click.
        _expanded = State(initialValue: !group.isSystem)
    }

    private var titleText: String { group.isSystem ? "System" : group.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            DisclosureGroup(isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(group.rows) { r in
                        Text("\(r.at) · \(r.event)\(r.detail.isEmpty ? "" : " · \(r.detail)")")
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.top, 4)
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(titleText).font(.callout.bold()).lineLimit(1)
                        Spacer()
                        statusChip
                    }
                    if !group.isSystem {
                        Text(group.phrase)
                            .font(.caption2).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .lineLimit(2)
                    } else {
                        Text("\(group.rows.count) system event\(group.rows.count == 1 ? "" : "s")")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    private var statusChip: some View {
        Text(group.status.label)
            .font(.caption2.bold())
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(group.status.color, in: Capsule())
    }
}
