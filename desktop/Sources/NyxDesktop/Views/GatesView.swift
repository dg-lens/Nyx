import SwiftUI

struct GatesView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        ScrollView {
            if store.state.gates.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "checkmark.seal").font(.largeTitle).foregroundStyle(.secondary)
                    Text("No gates waiting").foregroundStyle(.secondary)
                    Text("A pipeline run pauses here when it needs your decision.")
                        .font(.caption).foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity).padding(.top, 60)
            } else {
                VStack(spacing: 12) {
                    ForEach(store.state.gates) { GateCard(gate: $0) }
                }
            }
        }
    }
}

struct GateCard: View {
    @EnvironmentObject var store: Store
    let gate: Gate
    @State private var note = ""
    @State private var envInputs: [String: String] = [:]
    @State private var envSaved: Set<String> = []

    private var isPreview: Bool { gate.gate == "preview" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(isPreview ? "◧ PREVIEW" : "◨ REVIEW")
                    .font(.caption.bold()).foregroundStyle(.tint)
                Spacer()
                Text(gate.repo.isEmpty ? gate.id : "\(gate.id) · \(gate.repo)")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(gate.summary)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            if !gate.preflight.isEmpty {
                Divider()
                Text("Preflight requirements").font(.caption.bold()).foregroundStyle(.secondary)
                ForEach(gate.preflight) { preflightRow($0) }
            }

            TextField(isPreview ? "revise note (optional)" : "fix note (optional)", text: $note)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button(isPreview ? "Approve" : "Proceed") {
                    store.decide(gate.id, isPreview ? "go" : "proceed", note: nil)
                }
                .buttonStyle(.borderedProminent)
                Button(isPreview ? "Revise" : "Fix") {
                    store.decide(gate.id, isPreview ? "revise" : "fix", note: note)
                }
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private func preflightRow(_ req: PreflightReq) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(statusIcon(req.status))
                Text(req.env ?? req.item)
                    .font(req.env != nil ? .system(.callout, design: .monospaced) : .callout)
                Spacer()
                Text(req.status).font(.caption2).foregroundStyle(.secondary)
            }
            if !req.note.isEmpty {
                Text(req.note).font(.caption2).foregroundStyle(.secondary)
            }
            if let env = req.env, req.status != "ready" {
                if envSaved.contains(env) {
                    Text("✓ saved to .env").font(.caption2).foregroundStyle(.green)
                } else {
                    HStack {
                        Group {
                            if SettingsStore.looksSecret(env) {
                                SecureField("value for \(env)", text: binding(env))
                            } else {
                                TextField("value for \(env)", text: binding(env))
                            }
                        }
                        .textFieldStyle(.roundedBorder)
                        Button("Set") { setEnv(env) }.disabled((envInputs[env] ?? "").isEmpty)
                    }
                }
            }
        }
        .padding(.vertical, 1)
    }

    private func binding(_ env: String) -> Binding<String> {
        Binding(get: { envInputs[env] ?? "" }, set: { envInputs[env] = $0 })
    }

    private func setEnv(_ env: String) {
        let v = envInputs[env] ?? ""
        guard !v.isEmpty else { return }
        writeEnvVar(env, v)
        envSaved.insert(env)
        envInputs[env] = ""
    }

    private func statusIcon(_ s: String) -> String {
        switch s {
        case "ready": return "✓"
        case "missing": return "⚠"
        default: return "?"
        }
    }
}
