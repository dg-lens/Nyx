import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct SettingsView: View {
    @StateObject private var s = SettingsStore()
    @State private var logoVersion = 0

    private let models = ["haiku", "sonnet", "opus"]
    private let taskTypes = ["code", "analysis", "assistant", "content", "pipeline"]
    private let strictness = ["lenient", "normal", "strict"]

    var body: some View {
        Form {
            identitySection
            pluginsSection
            pipelineSection
            dispatcherSection
            integrationsSection
            daemonSection
            dataSection
        }
        .formStyle(.grouped)
        .onAppear { s.load() }
        .overlay(alignment: .bottom) {
            if !s.status.isEmpty {
                Text(s.status).font(.caption).padding(6)
                    .background(.quaternary, in: Capsule()).padding(.bottom, 6)
            }
        }
    }

    // MARK: settings.json binding that persists on every change
    private func saving<T>(_ kp: WritableKeyPath<NyxSettings, T>) -> Binding<T> {
        Binding(get: { s.settings[keyPath: kp] },
                set: { s.settings[keyPath: kp] = $0; s.saveSettings() })
    }
    private func modelBinding(_ type: String) -> Binding<String> {
        Binding(get: { s.settings.dispatcher.defaultModels[type] ?? "sonnet" },
                set: { s.settings.dispatcher.defaultModels[type] = $0; s.saveSettings() })
    }

    // MARK: Identity
    private var identitySection: some View {
        Section("Identity") {
            HStack(spacing: 14) {
                logoView.frame(width: 56, height: 56)
                VStack(alignment: .leading, spacing: 6) {
                    Button("Choose logo…") { chooseLogo() }
                    if FileManager.default.fileExists(atPath: Layout.logoPath.path) {
                        Button("Reset to default") { try? FileManager.default.removeItem(at: Layout.logoPath); logoVersion += 1; applyDockIcon() }
                            .controlSize(.small)
                    }
                }
            }
            TextField("Instance name", text: $s.instanceName)
            TextField("Operator name", text: $s.operatorName)
            HStack {
                Button("Save identity") { s.saveIdentity() }.buttonStyle(.borderedProminent)
                Text("App title, menu bar and notifications use the instance name.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var logoView: some View {
        if let img = NSImage(contentsOf: Layout.logoPath) {
            Image(nsImage: img).resizable().scaledToFit()
                .clipShape(RoundedRectangle(cornerRadius: 8)).id(logoVersion)
        } else {
            Image(systemName: "circle.hexagongrid.fill").resizable().scaledToFit()
                .foregroundStyle(.tint).id(logoVersion)
        }
    }

    private func chooseLogo() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg, .image]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url, let img = NSImage(contentsOf: url) else { return }
        try? FileManager.default.removeItem(at: Layout.logoPath)
        // Normalize to a clean PNG (the picker may hand us a JPEG); iconutil and
        // the menu-bar/dock all want a real PNG at logo.png.
        if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: Layout.logoPath)
        } else {
            try? FileManager.default.copyItem(at: url, to: Layout.logoPath)
        }
        logoVersion += 1
        applyDockIcon()
        s.status = "Logo updated"
    }

    // MARK: Plugins
    private var pluginsSection: some View {
        Section("Plugins") {
            if s.plugins.isEmpty {
                Text("No plugins found.").foregroundStyle(.secondary)
            }
            ForEach(s.plugins) { p in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(p.name).font(.body)
                        Text("\(p.source) · \(p.tier) · runtime \(p.runtime)\(p.env.isEmpty ? "" : " · env: \(p.env.joined(separator: ", "))")")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Toggle("", isOn: Binding(get: { p.enabled }, set: { s.setPlugin(p.name, enabled: $0) }))
                        .labelsHidden()
                }
            }
            Button("Reveal plugins folder") { NSWorkspace.shared.activateFileViewerSelecting([Layout.pluginsDir]) }
                .controlSize(.small)
        }
    }

    // MARK: Pipeline
    private var pipelineSection: some View {
        Section("Pipeline") {
            Stepper("Concurrent coder cap: \(s.settings.pipeline.concurrentCap)",
                    value: saving(\.pipeline.concurrentCap), in: 1...16)
            Toggle("Slack notifications", isOn: saving(\.pipeline.slackNotifications))
            Toggle("Auto-merge PRs", isOn: saving(\.pipeline.autoMerge))
            Picker("Review strictness", selection: saving(\.pipeline.reviewStrictness)) {
                ForEach(strictness, id: \.self) { Text($0) }
            }
        }
    }

    // MARK: Dispatcher
    private var dispatcherSection: some View {
        Section("Dispatcher") {
            Stepper("Max chain depth: \(s.settings.dispatcher.maxChainDepth)",
                    value: saving(\.dispatcher.maxChainDepth), in: 1...10)
            Stepper("Task timeout: \(s.settings.dispatcher.taskTimeoutMs / 60_000) min",
                    value: Binding(get: { s.settings.dispatcher.taskTimeoutMs / 60_000 },
                                   set: { s.settings.dispatcher.taskTimeoutMs = $0 * 60_000; s.saveSettings() }),
                    in: 1...120)
            Toggle("Concurrency guard (skip tick if claude is running)",
                   isOn: saving(\.dispatcher.concurrencyGuard))
            DisclosureGroup("Default model by type") {
                ForEach(taskTypes, id: \.self) { t in
                    Picker(t, selection: modelBinding(t)) {
                        ForEach(models, id: \.self) { Text($0) }
                    }
                }
            }
        }
    }

    // MARK: Integrations
    private var integrationsSection: some View {
        Section("Integrations") {
            LabeledContent("Anthropic auth", value: s.hasApiKey ? "API key (billed)" : "OAuth / Max")
            TextField("Slack channel", text: $s.slackChannel)
            TextField("Memory backend", text: $s.memoryBackend)
            Button("Save integrations") { s.saveIntegrations() }
            Text("Tokens (Slack, RemoteActions) live in Data/.env and are never shown here.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: Daemon
    private var daemonSection: some View {
        Section("Daemon") {
            HStack {
                Circle().fill(s.daemonRunning ? Color.green : Color.secondary).frame(width: 8, height: 8)
                Text(s.daemonRunning ? "Running (5-min ticks)" : "Stopped")
                Spacer()
                Button("Refresh") { s.refreshDaemonStatus() }.controlSize(.small)
            }
            HStack {
                Button("Start") { s.daemonStart() }.disabled(s.daemonRunning)
                Button("Stop") { s.daemonStop() }.disabled(!s.daemonRunning)
                Spacer()
                Button("Open logs") { NSWorkspace.shared.open(Layout.dataDir.appendingPathComponent("logs")) }
                    .controlSize(.small)
            }
        }
    }

    // MARK: Data / About
    private var dataSection: some View {
        Section("Data & About") {
            LabeledContent("Data directory", value: Layout.dataDir.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
            Button("Verify audit chain") {
                let ok = SettingsStore.shell("\(Layout.repoRoot.path)/scripts/nyx audit --chain")
                s.status = ok ? "Audit chain OK" : "Audit chain check failed"
            }
            Button("Reveal queue file") { NSWorkspace.shared.activateFileViewerSelecting([Layout.queuePath]) }
            Link("dg-lens/Nyx on GitHub", destination: URL(string: "https://github.com/dg-lens/Nyx")!)
        }
    }
}
