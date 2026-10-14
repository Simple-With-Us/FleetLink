import SwiftUI

public struct CreateSlugView: View {
    @ObservedObject var portalManager: PortalManager
    var onSelectArtifact: (URL) -> Void

    @EnvironmentObject private var session: SessionManager
    @AppStorage("fleetlink_server_host") private var serverHost: String = "https://fleetlink.online"

    @State private var creationMode: CreationMode = .redirect
    @State private var customSlug: String = ""
    @State private var targetURL: String = ""
    @State private var textFileName: String = "notes.md"
    @State private var textContent: String = "# Notes\n\nShared from FleetLink."
    @State private var selectedTTLSeconds: Int = 15552000 // 180 days default for redirects
    @State private var password: String = ""
    @State private var selectedDomain: String = "fleetlink.online"

    @State private var isSubmitting: Bool = false
    @State private var createdURLString: String? = nil
    @State private var errorMessage: String? = nil
    @State private var hasCopied: Bool = false

    enum CreationMode: String, CaseIterable, Identifiable {
        case redirect = "Short link"
        case upload = "Text file"

        var id: String { rawValue }
    }

    struct TTLOption: Identifiable {
        let label: String
        let seconds: Int
        var id: Int { seconds }
    }

    let redirectTTLs: [TTLOption] = [
        TTLOption(label: "24 Hours", seconds: 86400),
        TTLOption(label: "7 Days", seconds: 604800),
        TTLOption(label: "30 Days", seconds: 2592000),
        TTLOption(label: "180 Days (6 Months)", seconds: 15552000)
    ]

    let uploadTTLs: [TTLOption] = [
        TTLOption(label: "6 Hours", seconds: 21600),
        TTLOption(label: "24 Hours", seconds: 86400),
        TTLOption(label: "3 Days", seconds: 259200),
        TTLOption(label: "7 Days", seconds: 604800)
    ]

    public init(portalManager: PortalManager, onSelectArtifact: @escaping (URL) -> Void) {
        self.portalManager = portalManager
        self.onSelectArtifact = onSelectArtifact
    }

    public var body: some View {
        NavigationStack {
            Form {
                // Success Banner
                if let urlString = createdURLString {
                    Section {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(.green)
                                    .font(.title3)
                                Text("Your link is ready")
                                    .font(.headline)
                                    .accessibilityAddTraits(.isHeader)
                            }

                            Text(urlString)
                                .font(.subheadline.monospaced())
                                .foregroundColor(.primary)
                                .padding(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color(UIColor.secondarySystemFill))
                                .cornerRadius(8)

                            HStack(spacing: 12) {
                                Button {
                                    UIPasteboard.general.string = urlString
                                    hasCopied = true
                                    Task {
                                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                                        hasCopied = false
                                    }
                                } label: {
                                    HStack {
                                        Image(systemName: hasCopied ? "checkmark" : "doc.on.doc")
                                        Text(hasCopied ? "Copied" : "Copy link")
                                    }
                                    .font(.subheadline.bold())
                                    .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.borderedProminent)

                                Button {
                                    if let url = URL(string: urlString) {
                                        onSelectArtifact(url)
                                    }
                                } label: {
                                    HStack {
                                        Image(systemName: "arrow.up.right.square")
                                        Text("View")
                                    }
                                    .font(.subheadline.bold())
                                    .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                        .padding(.vertical, 6)
                    }
                }

                if let err = errorMessage {
                    Section {
                        Label(err, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .accessibilityLabel("Error.  \(err)")
                    }
                }

                // Mode Picker
                Section("What to share") {
                    Picker("What to share", selection: $creationMode) {
                        ForEach(CreationMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: creationMode) { _, newMode in
                        if newMode == .redirect {
                            selectedTTLSeconds = 15552000
                        } else {
                            selectedTTLSeconds = 259200
                        }
                    }
                }

                // Configuration Fields
                if creationMode == .redirect {
                    Section("Web address") {
                        TextField("https://example.com", text: $targetURL)
                            .keyboardType(.URL)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .accessibilityLabel("Web address to open")
                    }
                } else {
                    Section("File name") {
                        TextField("notes.md", text: $textFileName)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                    }

                    Section("Content") {
                        TextEditor(text: $textContent)
                            .frame(minHeight: 140)
                            .font(.system(.body, design: .monospaced))
                    }
                }

                Section("Options") {
                    if creationMode == .redirect || !session.bearerSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        TextField("Short name (optional)", text: $customSlug)
                            .accessibilityLabel("Short name")
                            .accessibilityHint("Leave blank and FleetLink picks a name.")
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                    }

                    Picker("How long it stays up", selection: $selectedTTLSeconds) {
                        if creationMode == .redirect {
                            ForEach(redirectTTLs) { opt in
                                Text(opt.label).tag(opt.seconds)
                            }
                        } else {
                            ForEach(uploadTTLs) { opt in
                                Text(opt.label).tag(opt.seconds)
                            }
                        }
                    }

                    SecureField("Password (optional)", text: $password)
                        .accessibilityHint("Leave blank if anyone with the link may open it.")
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    Picker("Domain", selection: $selectedDomain) {
                        Text("fleetlink.online").tag("fleetlink.online")
                        Text("fleetlink.app").tag("fleetlink.app")
                    }
                }

                // Action
                Section {
                    Button {
                        submit()
                    } label: {
                        HStack {
                            Spacer()
                            if isSubmitting {
                                ProgressView()
                                    .padding(.trailing, 4)
                            }
                            Text(creationMode == .redirect ? "Create short link" : "Share file")
                                .bold()
                            Spacer()
                        }
                    }
                    .disabled(isSubmitting || !isFormValid)
                }
            }
            .navigationTitle("New link")
        }
    }

    private var isFormValid: Bool {
        if creationMode == .redirect {
            return !targetURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        } else {
            return !textContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func submit() {
        isSubmitting = true
        errorMessage = nil
        createdURLString = nil

        let slugToUse = customSlug.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : customSlug.trimmingCharacters(in: .whitespacesAndNewlines)
        let passToUse = password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : password.trimmingCharacters(in: .whitespacesAndNewlines)

        Task {
            if creationMode == .redirect {
                let res = await portalManager.createRedirect(
                    targetUrl: targetURL.trimmingCharacters(in: .whitespacesAndNewlines),
                    customSlug: slugToUse,
                    ttlSeconds: selectedTTLSeconds,
                    password: passToUse,
                    domain: selectedDomain,
                    host: serverHost,
                    token: session.bearerSecret
                )
                switch res {
                case .success(let url):
                    createdURLString = url
                    targetURL = ""
                    customSlug = ""
                case .failure(let err):
                    errorMessage = FleetLinkCopy.explain(err.localizedDescription)
                }
            } else {
                guard let data = textContent.data(using: .utf8) else {
                    errorMessage = "That text could not be saved.  Try again."
                    isSubmitting = false
                    return
                }
                let res = await portalManager.createUpload(
                    fileName: textFileName.trimmingCharacters(in: .whitespacesAndNewlines),
                    content: data,
                    customSlug: slugToUse,
                    ttlSeconds: selectedTTLSeconds,
                    password: passToUse,
                    domain: selectedDomain,
                    host: serverHost,
                    token: session.bearerSecret
                )
                switch res {
                case .success(let url):
                    createdURLString = url
                    customSlug = ""
                case .failure(let err):
                    errorMessage = FleetLinkCopy.explain(err.localizedDescription)
                }
            }
            isSubmitting = false
        }
    }
}
