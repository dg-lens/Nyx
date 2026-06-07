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
    @State private var envChoice: [String: String] = [:]   // env -> "global" | "custom"
    @State private var envInputs: [String: String] = [:]
    @State private var envSaved: Set<String> = []
    @State private var decisionAnswers: [String: String] = [:]

    private var isPreview: Bool { gate.gate == "preview" }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(isPreview ? "◧ PREVIEW" : "◨ REVIEW")
                    .font(.caption.bold()).foregroundStyle(.tint)
                Spacer()
                Text(gate.repo.isEmpty ? gate.id : "\(gate.id) · \(gate.repo)")
                    .font(.caption).foregroundStyle(.secondary)
            }

            // Go / no-go recommendation (clean line, not the raw brief).
            Text(gate.summary)
                .font(.callout.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            if !gate.preflight.isEmpty {
                Divider()
                Text("Requirements").font(.caption.bold()).foregroundStyle(.secondary)
                Text("Each secret can use Nyx's global value or a custom one scoped to just this run.")
                    .font(.caption2).foregroundStyle(.tertiary)
                ForEach(gate.preflight) { preflightRow($0) }
            }

            if !gate.decisions.isEmpty {
                Divider()
                Text("Decisions").font(.caption.bold()).foregroundStyle(.secondary)
                ForEach(gate.decisions) { decisionRow($0) }
            }

            TextField(isPreview ? "revise note (required)" : "fix note (required)", text: $note)
                .textFieldStyle(.roundedBorder)

            HStack {
                if isPreview {
                    Button("Go") { saveDecisions(); store.decide(gate.id, "go", note: nil) }
                        .buttonStyle(.borderedProminent)
                    Button("Revise") { store.decide(gate.id, "revise", note: note) }
                        .disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Abort") { store.decide(gate.id, "abort", note: nil) }
                } else {
                    // Accept = merge the held task(s) + continue the build (non-destructive).
                    Button("Accept & continue") { store.decide(gate.id, "accept", note: nil) }
                        .buttonStyle(.borderedProminent)
                    Button("Proceed (ship merged)") { store.decide(gate.id, "proceed", note: nil) }
                    Button("Fix") { store.decide(gate.id, "fix", note: note) }
                        .disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Rollback") { store.decide(gate.id, "rollback", note: nil) }
                    Button("Abort") { store.decide(gate.id, "abort", note: nil) }
                }
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .onAppear {
            for d in gate.decisions where decisionAnswers[d.question] == nil {
                // Prefer a previously-submitted answer; fall back to the planner's default.
                decisionAnswers[d.question] = d.savedAnswer ?? (d.defaultAnswer == "no" ? "no" : "yes")
            }
        }
    }

    // MARK: requirements — use global secret, or a per-run custom value
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
            if !req.note.isEmpty { Text(req.note).font(.caption2).foregroundStyle(.secondary) }
            if let env = req.env {
                if envSaved.contains(env) {
                    Text("✓ custom value set for this run").font(.caption2).foregroundStyle(.green)
                } else {
                    Picker("", selection: choiceBinding(env)) {
                        Text("Use global").tag("global")
                        Text("Custom").tag("custom")
                    }
                    .pickerStyle(.segmented).frame(width: 200)
                    if envChoice[env] == "custom" {
                        HStack {
                            Group {
                                if SettingsStore.looksSecret(env) {
                                    SecureField("value for this run only", text: inputBinding(env))
                                } else {
                                    TextField("value for this run only", text: inputBinding(env))
                                }
                            }
                            .textFieldStyle(.roundedBorder)
                            Button("Set") { setCustom(env) }.disabled((envInputs[env] ?? "").isEmpty)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 1)
    }

    // MARK: decisions — Yes/No (context goes in the revise/fix note, not here)
    @ViewBuilder
    private func decisionRow(_ d: GateDecision) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(d.question).font(.callout).fixedSize(horizontal: false, vertical: true)
            Picker("", selection: answerBinding(d.question)) {
                Text("Yes").tag("yes")
                Text("No").tag("no")
            }
            .pickerStyle(.segmented).frame(width: 120)
        }
        .padding(.vertical, 1)
    }

    // MARK: bindings + actions
    private func choiceBinding(_ env: String) -> Binding<String> {
        Binding(get: { envChoice[env] ?? "global" }, set: { envChoice[env] = $0 })
    }
    private func inputBinding(_ env: String) -> Binding<String> {
        Binding(get: { envInputs[env] ?? "" }, set: { envInputs[env] = $0 })
    }
    private func answerBinding(_ q: String) -> Binding<String> {
        Binding(get: { decisionAnswers[q] ?? "yes" }, set: { decisionAnswers[q] = $0; saveDecisions() })
    }

    private func setCustom(_ env: String) {
        let v = envInputs[env] ?? ""
        guard !v.isEmpty else { return }
        writeRunSecret(gate.id, env, v)
        envSaved.insert(env)
        envInputs[env] = ""
    }

    private func saveDecisions() {
        let answers: [[String: String]] = gate.decisions.map { d in
            ["question": d.question, "answer": decisionAnswers[d.question] ?? (d.defaultAnswer == "no" ? "no" : "yes")]
        }
        writeRunDecisions(gate.id, answers)
    }

    private func statusIcon(_ s: String) -> String {
        switch s {
        case "ready": return "✓"
        case "missing": return "⚠"
        default: return "?"
        }
    }
}
