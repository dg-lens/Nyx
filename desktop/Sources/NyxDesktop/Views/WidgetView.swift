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
                case "stat": statBody(manifest)
                case "text": textBody(manifest)
                default:     unavailable(manifest.title)
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
}
