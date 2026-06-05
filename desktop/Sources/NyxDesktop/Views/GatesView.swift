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
}
