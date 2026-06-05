import SwiftUI

struct DispatchView: View {
    @EnvironmentObject var store: Store
    @State private var text = ""
    @State private var type = "code"
    @State private var model = "auto"
    @State private var priority = "normal"
    @State private var repo = ""

    private let types = ["code", "analysis", "assistant", "content", "pipeline"]
    private let priorities = ["high", "normal", "low"]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Describe work in plain language. A sonnet pass breaks it into one or more fully-tagged tasks — you don't write the task syntax.")
                .font(.caption).foregroundStyle(.secondary)

            TextEditor(text: $text)
                .font(.body)
                .frame(minHeight: 110)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))

            HStack(alignment: .bottom, spacing: 14) {
                labeled("Type") {
                    Picker("", selection: $type) { ForEach(types, id: \.self) { Text($0) } }
                        .labelsHidden().fixedSize()
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

            HStack(alignment: .bottom) {
                labeled("Repo (optional)") {
                    TextField("org/name", text: $repo)
                        .textFieldStyle(.roundedBorder).frame(width: 240)
                }
                Spacer()
                Button {
                    store.dispatch(text: text, type: type, model: model, priority: priority,
                                   repo: repo.isEmpty ? nil : repo)
                    text = ""
                } label: {
                    if store.ticking {
                        HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Decomposing…") }
                    } else {
                        Label("Decompose & Queue", systemImage: "wand.and.stars")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || store.ticking)
            }

            if !store.lastDispatch.isEmpty {
                Text(store.lastDispatch).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
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
