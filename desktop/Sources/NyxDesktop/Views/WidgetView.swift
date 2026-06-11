import SwiftUI

// Renders a single placed widget. Dispatches on the manifest's `viz`. A layout
// referencing a MISSING manifest renders a neutral "widget unavailable" placeholder
// rather than crashing. In customize mode it shows the red delete X (top-right) and
// a subtle wobble-free lift; text widgets become editable only outside customize so
// dragging doesn't fight the text field.
struct WidgetView: View {
    let instance: WidgetInstance
    let manifest: WidgetManifest?
    let state: NyxState
    // Pre-resolved payload for status-viz widgets, from DashboardStore's cache.
    // Resolution does file IO and must never run inside body (the countdown
    // timer invalidates ~1×/sec).
    let statusPayload: StatusPayload
    let customizing: Bool
    let onDelete: () -> Void
    let onEditText: (String) -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            card
            if customizing {
                Button(action: onDelete) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(.white, .red)
                }
                .buttonStyle(.plain)
                .offset(x: 6, y: -6)
                .help("Remove widget")
            }
        }
    }

    @ViewBuilder
    private var card: some View {
        Group {
            if let manifest {
                switch manifest.viz {
                case "stat":   statBody(manifest)
                case "text":   textBody(manifest)
                case "status": statusBody(manifest)
                default:       unavailable(manifest.title)
                }
            } else {
                unavailable("widget unavailable: \(instance.manifestId)")
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(.quaternary, lineWidth: customizing ? 1 : 0))
    }

    // MARK: viz: stat — a big resolved value + caption.
    private func statBody(_ m: WidgetManifest) -> some View {
        let key: String = {
            if case .store(let k) = m.source { return k }
            return ""
        }()
        return VStack(alignment: .leading, spacing: 4) {
            Text(m.title.uppercased()).font(.caption2.bold()).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Text(StoreKeyResolver.value(key, state))
                .font(.system(size: 30, weight: .semibold, design: .rounded))
                .lineLimit(1).minimumScaleFactor(0.5)
            Text(StoreKeyResolver.caption(key)).font(.caption2).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    // MARK: viz: text — editable note (static source) or read-only description.
    @ViewBuilder
    private func textBody(_ m: WidgetManifest) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(m.title.uppercased()).font(.caption2.bold()).foregroundStyle(.secondary)
            if case .staticText = m.source {
                if customizing {
                    Text(instance.text ?? "")
                        .font(.callout).foregroundStyle(.primary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                } else {
                    TextEditor(text: Binding(
                        get: { instance.text ?? "" },
                        set: { onEditText($0) }))
                        .font(.callout)
                        .scrollContentBackground(.hidden)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            } else {
                Text(m.description ?? "")
                    .font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }

    private func unavailable(_ msg: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: "questionmark.square.dashed")
                .font(.title2).foregroundStyle(.tertiary)
            Text(msg).font(.caption).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    // MARK: viz: status — a dumb card: health dot + label header, up to seven
    // caption lines, freshness footer. All values come from the resolved
    // StatusPayload (file source or a nyx-ops composite store key). Adapted from
    // the IrisLiveOps QuadrantCard pattern.
    @ViewBuilder
    private func statusBody(_ m: WidgetManifest) -> some View {
        let payload = statusPayload
        VStack(alignment: .leading, spacing: 8) {
            statusHeader(m, payload)
            Divider()
            statusLines(payload)
            Spacer(minLength: 0)
            statusFooter(payload)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func statusHeader(_ m: WidgetManifest, _ p: StatusPayload) -> some View {
        HStack(spacing: 6) {
            Text(m.title.uppercased()).font(.caption2.bold()).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Circle()
                .fill(HealthColor.color(p.health))
                .frame(width: 9, height: 9)
            Text(HealthColor.label(p.health))
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func statusLines(_ p: StatusPayload) -> some View {
        if p.lines.isEmpty {
            // Never an unexplained blank: mirror the footer's intent inline.
            Text(p.state == .preparing ? "preparing…" : "no data")
                .font(.caption).foregroundStyle(.tertiary)
        } else {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(p.lines.prefix(7).enumerated()), id: \.offset) { _, line in
                    Text(line)
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func statusFooter(_ p: StatusPayload) -> some View {
        HStack(spacing: 5) {
            Image(systemName: footerSymbol(p.state))
                .font(.system(size: 10))
            Text(footerText(p.state))
                .font(.caption2)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .foregroundStyle(.tertiary)
    }

    private func footerSymbol(_ s: FreshnessState) -> String {
        switch s {
        case .fresh:     return "circle.fill"
        case .stale:     return "clock"
        case .preparing: return "ellipsis"
        case .error:     return "exclamationmark.triangle"
        }
    }

    private func footerText(_ s: FreshnessState) -> String {
        switch s {
        case .fresh(let d):   return "updated \(Relative.string(from: d))"
        case .stale(let d):   return "last good \(Relative.string(from: d))"
        case .preparing:      return "preparing"
        case .error(let msg): return String(msg.prefix(60))
        }
    }
}

// Maps a status widget's HealthLevel onto a system colour + label. Deliberately a
// tiny mapping (not a theme) so it reuses Nyx's existing palette: green/yellow/red
// system colours for ok/warn/critical, neutral gray for unknown.
enum HealthColor {
    static func color(_ level: HealthLevel) -> Color {
        switch level {
        case .ok:        return .green
        case .warn:      return .yellow
        case .critical:  return .red
        case .unknown:   return .gray
        }
    }

    static func label(_ level: HealthLevel) -> String {
        switch level {
        case .ok:        return "OK"
        case .warn:      return "Warn"
        case .critical:  return "Critical"
        case .unknown:   return "Unknown"
        }
    }
}
