import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

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
    @State private var titleText: String = ""
    @State private var descriptionText: String = ""
    @State private var selectedTTLSeconds: Int = 15552000
    @State private var password: String = ""
    @State private var selectedDomain: String = "fleetlink.online"
    @State private var pendingFiles: [PendingFile] = []
    @State private var previewFile: PendingFile?
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var previewItem: PhotosPickerItem?
    @State private var showFileImporter = false

    @State private var isSubmitting: Bool = false
    @State private var createdURLString: String? = nil
    @State private var errorMessage: String? = nil
    @State private var hasCopied: Bool = false

    enum CreationMode: String, CaseIterable, Identifiable {
        case redirect = "Short link"
        case note = "Text file"
        case files = "Files"

        var id: String { rawValue }
    }

    struct PendingFile: Identifiable {
        let id = UUID()
        let name: String
        let data: Data
        let mime: String

        var part: UploadPart { UploadPart(fileName: name, content: data, mimeType: mime) }
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
        TTLOption(label: "180 Days (6 Months)", seconds: 15552000),
        TTLOption(label: "Until you delete it", seconds: 0)
    ]

    let uploadTTLs: [TTLOption] = [
        TTLOption(label: "1 Hour", seconds: 3600),
        TTLOption(label: "6 Hours", seconds: 21600),
        TTLOption(label: "24 Hours", seconds: 86400),
        TTLOption(label: "3 Days", seconds: 259200),
        TTLOption(label: "7 Days", seconds: 604800),
        TTLOption(label: "Until you delete it", seconds: 0)
    ]

    public init(portalManager: PortalManager, onSelectArtifact: @escaping (URL) -> Void) {
        self.portalManager = portalManager
        self.onSelectArtifact = onSelectArtifact
    }

    public var body: some View {
        NavigationStack {
            Form {
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
                            .accessibilityLabel("Error.\u{00A0} \(err)")
                    }
                }

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
                        } else if selectedTTLSeconds == 15552000 || selectedTTLSeconds == 2592000 {
                            selectedTTLSeconds = 259200
                        }
                    }
                }

                if creationMode == .redirect {
                    Section("Web address") {
                        TextField("https://example.com", text: $targetURL)
                            .keyboardType(.URL)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .accessibilityLabel("Web address to open")
                    }
                } else if creationMode == .note {
                    Section("File name") {
                        TextField("notes.md", text: $textFileName)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                    }
                    Section("Note") {
                        TextEditor(text: $textContent)
                            .frame(minHeight: 160)
                            .font(.system(.body, design: .monospaced))
                    }
                } else {
                    Section("Files") {
                        PhotosPicker(selection: $photoItems, maxSelectionCount: 20, matching: .images) {
                            Label("Choose photos", systemImage: "photo.on.rectangle")
                        }
                        Button {
                            showFileImporter = true
                        } label: {
                            Label("Choose files", systemImage: "folder")
                        }
                        if pendingFiles.isEmpty {
                            Text("Add one or more files.\u{00A0} A sign-in code in Settings is required to publish.")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        } else {
                            ForEach(pendingFiles) { file in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(file.name)
                                            .lineLimit(1)
                                        Text(ByteCountFormatter.string(fromByteCount: Int64(file.data.count), countStyle: .file))
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                    }
                                    Spacer()
                                    Button(role: .destructive) {
                                        pendingFiles.removeAll { $0.id == file.id }
                                    } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .foregroundColor(.secondary)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Remove \(file.name)")
                                }
                            }
                        }
                    }
                }

                Section("Preview") {
                    TextField("Title (optional)", text: $titleText)
                        .autocorrectionDisabled()
                    TextField("Description (optional)", text: $descriptionText)
                        .autocorrectionDisabled()
                    if creationMode != .redirect {
                        PhotosPicker(selection: $previewItem, matching: .images) {
                            Label(previewFile == nil ? "Preview picture (optional)" : "Preview: \(previewFile?.name ?? "image")", systemImage: "photo")
                        }
                        if previewFile != nil {
                            Button("Remove preview picture", role: .destructive) {
                                previewFile = nil
                                previewItem = nil
                            }
                        }
                    }
                }

                Section {
                    TextField("Short name (optional)", text: $customSlug)
                        .accessibilityLabel("Short name")
                        .accessibilityHint("Leave blank and FleetLink picks a name.")
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    Picker("How long it stays up", selection: $selectedTTLSeconds) {
                        ForEach((creationMode == .redirect ? redirectTTLs : uploadTTLs).filter { $0.seconds > 0 || session.user?.isAdmin == true }) { opt in
                            Text(opt.label).tag(opt.seconds)
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
                } header: {
                    Text("Options")
                } footer: {
                    Text("Publishing uses the sign-in code in Settings.\u{00A0} A custom name on a file share needs an account-owner sign-in.\u{00A0} Short links can use a custom name with either sign-in.\u{00A0} Until you delete it is kept only for an account owner.")
                        .font(.caption)
                }

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
                            Text(buttonTitle)
                                .bold()
                            Spacer()
                        }
                    }
                    .disabled(isSubmitting || !isFormValid)
                }
            }
            .navigationTitle("New link")
            .onAppear {
                if let host = URL(string: serverHost)?.host {
                    selectedDomain = host
                }
            }
            .onChange(of: selectedDomain) { _, newValue in
                let next = "https://\(newValue)"
                if serverHost != next { serverHost = next }
            }
            .onChange(of: photoItems) { _, items in
                guard !items.isEmpty else { return }
                Task {
                    var next = pendingFiles
                    for item in items {
                        if let file = await pendingFile(from: item, prefix: "photo") {
                            next.append(file)
                        }
                    }
                    pendingFiles = next
                    photoItems = []
                }
            }
            .onChange(of: previewItem) { _, item in
                guard let item else { return }
                Task {
                    previewFile = await pendingFile(from: item, prefix: "preview")
                }
            }
            .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.data], allowsMultipleSelection: true) { result in
                if case .success(let urls) = result {
                    for url in urls {
                        let scoped = url.startAccessingSecurityScopedResource()
                        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                        guard let data = try? Data(contentsOf: url) else { continue }
                        pendingFiles.append(PendingFile(name: url.lastPathComponent, data: data, mime: mimeType(for: url.lastPathComponent, data: data)))
                    }
                }
            }
        }
    }

    private var buttonTitle: String {
        switch creationMode {
        case .redirect: return "Create short link"
        case .note: return "Share file"
        case .files: return "Share files"
        }
    }

    private var isFormValid: Bool {
        switch creationMode {
        case .redirect:
            return !targetURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .note:
            return !textContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .files:
            return !pendingFiles.isEmpty
        }
    }

    private func submit() {
        isSubmitting = true
        errorMessage = nil
        createdURLString = nil

        let slugToUse = customSlug.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : customSlug.trimmingCharacters(in: .whitespacesAndNewlines)
        let passToUse = password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : password.trimmingCharacters(in: .whitespacesAndNewlines)
        let titleToUse = titleText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : titleText.trimmingCharacters(in: .whitespacesAndNewlines)
        let descriptionToUse = descriptionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : descriptionText.trimmingCharacters(in: .whitespacesAndNewlines)
        let host = "https://\(selectedDomain)"

        Task {
            let result: Result<String, PortalError>
            switch creationMode {
            case .redirect:
                result = await portalManager.createRedirect(
                    targetUrl: targetURL.trimmingCharacters(in: .whitespacesAndNewlines),
                    customSlug: slugToUse,
                    ttlSeconds: selectedTTLSeconds,
                    password: passToUse,
                    title: titleToUse,
                    description: descriptionToUse,
                    domain: selectedDomain,
                    host: host,
                    token: session.apiToken
                )
            case .note:
                let name = textFileName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "notes.md" : textFileName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard let data = textContent.data(using: .utf8) else {
                    errorMessage = "That text could not be saved.\u{00A0} Try again."
                    isSubmitting = false
                    return
                }
                result = await portalManager.createUpload(
                    files: [UploadPart(fileName: name, content: data, mimeType: mimeType(for: name, data: data))],
                    customSlug: slugToUse,
                    ttlSeconds: selectedTTLSeconds,
                    password: passToUse,
                    title: titleToUse,
                    description: descriptionToUse,
                    preview: previewFile?.part,
                    domain: selectedDomain,
                    host: host,
                    token: session.apiToken
                )
            case .files:
                result = await portalManager.createUpload(
                    files: pendingFiles.map(\.part),
                    customSlug: slugToUse,
                    ttlSeconds: selectedTTLSeconds,
                    password: passToUse,
                    title: titleToUse,
                    description: descriptionToUse,
                    preview: previewFile?.part,
                    domain: selectedDomain,
                    host: host,
                    token: session.apiToken
                )
            }

            switch result {
            case .success(let url):
                createdURLString = url
                if creationMode == .redirect { targetURL = "" }
                if creationMode == .files { pendingFiles = [] }
                customSlug = ""
                password = ""
            case .failure(let err):
                errorMessage = FleetLinkCopy.explain(err.localizedDescription)
            }
            isSubmitting = false
        }
    }

    private func pendingFile(from item: PhotosPickerItem, prefix: String) async -> PendingFile? {
        guard let data = try? await item.loadTransferable(type: Data.self), !data.isEmpty else { return nil }
        let sniffed = sniff(data)
        let name = "\(prefix)-\(UUID().uuidString.prefix(6)).\(sniffed.ext)"
        return PendingFile(name: name, data: data, mime: sniffed.mime)
    }

    private func sniff(_ data: Data) -> (mime: String, ext: String) {
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return ("image/png", "png") }
        if data.starts(with: [0xFF, 0xD8, 0xFF]) { return ("image/jpeg", "jpg") }
        if data.starts(with: [0x47, 0x49, 0x46]) { return ("image/gif", "gif") }
        if data.count > 12, String(data: data.prefix(4), encoding: .ascii) == "RIFF" {
            return ("image/webp", "webp")
        }
        return ("application/octet-stream", "bin")
    }

    private func mimeType(for fileName: String, data: Data) -> String {
        let lower = fileName.lowercased()
        if lower.hasSuffix(".md") || lower.hasSuffix(".markdown") { return "text/markdown" }
        if lower.hasSuffix(".txt") || lower.hasSuffix(".log") { return "text/plain" }
        if lower.hasSuffix(".json") { return "application/json" }
        if lower.hasSuffix(".html") || lower.hasSuffix(".htm") { return "text/html" }
        if lower.hasSuffix(".pdf") { return "application/pdf" }
        if lower.hasSuffix(".png") { return "image/png" }
        if lower.hasSuffix(".jpg") || lower.hasSuffix(".jpeg") { return "image/jpeg" }
        if lower.hasSuffix(".gif") { return "image/gif" }
        if lower.hasSuffix(".webp") { return "image/webp" }
        let sniffed = sniff(data)
        return sniffed.mime == "application/octet-stream" ? "application/octet-stream" : sniffed.mime
    }
}
