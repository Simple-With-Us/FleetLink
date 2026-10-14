import SwiftUI

public struct ArtifactContainerView: View {
    @ObservedObject var loader: ArtifactLoader
    let isClip: Bool
    @State private var showingShareSheet = false
    @State private var linkCopied = false
    @State private var viewMode: ViewMode = .content
    @State private var unlockPassword = ""

    enum ViewMode {
        case content
        case fileList
    }

    public init(loader: ArtifactLoader, isClip: Bool = false) {
        self.loader = loader
        self.isClip = isClip
    }

    public var body: some View {
        VStack(spacing: 0) {
            switch loader.state {
            case .idle:
                idleView
            case .loading:
                loadingView
            case .loaded(let artifact):
                loadedView(artifact)
            case .locked(let url):
                lockedView(url)
            case .redirect(let source, let target):
                redirectView(source: source, target: target)
            case .expired:
                expiredView
            case .notFound:
                notFoundView
            case .failure(let message):
                failureView(message)
            }
        }
        .sheet(isPresented: $showingShareSheet) {
            if case .loaded(let artifact) = loader.state {
                ShareSheet(items: [artifact.sourceURL])
            }
        }
    }

    private var idleView: some View {
        VStack(spacing: 16) {
            Image(systemName: "link.badge.plus")
                .font(.system(size: 56))
                .foregroundColor(.accentColor)
            Text("FleetLink Artifact Hosting")
                .font(.title2.bold())
            Text("Open an artifact link via fleetlink.online or fleetlink.app to instantly preview it.")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.3)
            Text("Loading FleetLink Artifact...")
                .font(.headline)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func lockedView(_ url: URL) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.fill")
                .font(.system(size: 56))
                .foregroundColor(.orange)
            Text("Password Required")
                .font(.title2.bold())
            Text("This share is locked.  Enter the password to open it.")
                .font(.body)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            SecureField("Password", text: $unlockPassword)
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 32)
                .accessibilityIdentifier("sharePasswordField")
            if let message = loader.lockMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundColor(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
            Button("Unlock") {
                let password = unlockPassword
                Task { await loader.load(url: url, password: password) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(unlockPassword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func redirectView(source: URL, target: URL) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "arrow.triangle.turn.up.right.circle.fill")
                .font(.system(size: 56))
                .foregroundColor(.green)
            Text("Redirect Link")
                .font(.title2.bold())
            Text(target.absoluteString)
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
                .padding(.horizontal, 32)
            Button("Open Destination") {
                UIApplication.shared.open(target)
            }
            .buttonStyle(.borderedProminent)
            Button("Copy Short Link") {
                UIPasteboard.general.url = source
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var expiredView: some View {
        VStack(spacing: 16) {
            Image(systemName: "clock.badge.exclamationmark")
                .font(.system(size: 64))
                .foregroundColor(.orange)
            Text("Link Expired")
                .font(.title2.bold())
            Text("This FleetLink share was temporary and has reached its expiration time.")
                .font(.body)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var notFoundView: some View {
        VStack(spacing: 16) {
            Image(systemName: "questionmark.folder")
                .font(.system(size: 64))
                .foregroundColor(.red)
            Text("Artifact Not Found")
                .font(.title2.bold())
            Text("The requested artifact or share could not be found.")
                .font(.body)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func failureView(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 64))
                .foregroundColor(.red)
            Text("Connection Error")
                .font(.title2.bold())
            Text(message)
                .font(.body)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }


    private func loadedView(_ artifact: ShareArtifact) -> some View {
        VStack(spacing: 0) {
            // Header bar
            HStack(spacing: 10) {
                HStack(spacing: 6) {
                    Image(systemName: "bolt.horizontal.circle.fill")
                        .foregroundColor(.cyan)
                    Text("FleetLink")
                        .font(.subheadline.bold())
                }

                HStack(spacing: 4) {
                    Text(artifact.domain)
                        .font(.caption2.bold())
                        .foregroundColor(.blue)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Color.blue.opacity(0.12))
                        .cornerRadius(6)

                    Text(artifact.slug)
                        .font(.caption2.monospaced())
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Color(UIColor.tertiarySystemFill))
                        .cornerRadius(6)
                }

                Spacer()

                // Actions
                if artifact.isDirectory && artifact.items.count > 1 {
                    Button(action: {
                        withAnimation {
                            viewMode = (viewMode == .content) ? .fileList : .content
                        }
                    }) {
                        Image(systemName: viewMode == .content ? "list.bullet" : "doc.text")
                            .font(.system(size: 15, weight: .semibold))
                            .padding(7)
                            .background(Color(UIColor.tertiarySystemFill))
                            .clipShape(Circle())
                    }
                }

                Button(action: {
                    UIPasteboard.general.url = artifact.sourceURL
                    withAnimation { linkCopied = true }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        withAnimation { linkCopied = false }
                    }
                }) {
                    Image(systemName: linkCopied ? "checkmark" : "link")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(linkCopied ? .green : .primary)
                        .padding(7)
                        .background(Color(UIColor.tertiarySystemFill))
                        .clipShape(Circle())
                }

                Button(action: {
                    showingShareSheet = true
                }) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 15, weight: .semibold))
                        .padding(7)
                        .background(Color(UIColor.tertiarySystemFill))
                        .clipShape(Circle())
                }

                Button(action: {
                    UIApplication.shared.open(artifact.sourceURL)
                }) {
                    Image(systemName: "safari")
                        .font(.system(size: 15, weight: .semibold))
                        .padding(7)
                        .background(Color(UIColor.tertiarySystemFill))
                        .clipShape(Circle())
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 10)
            .background(Color(UIColor.secondarySystemBackground))

            Divider()

            // Main body
            if viewMode == .fileList && artifact.isDirectory {
                DirectoryView(
                    items: artifact.items,
                    selectedItem: loader.selectedItem,
                    onSelect: { item in
                        Task {
                            await loader.selectItem(item)
                            viewMode = .content
                        }
                    }
                )
            } else {
                artifactContentView(artifact)
            }

            // App Clip install banner
            if isClip {
                appClipFooter
            }
        }
    }

    @ViewBuilder
    private func artifactContentView(_ artifact: ShareArtifact) -> some View {
        if let currentItem = loader.selectedItem {
            switch currentItem.kind {
            case .markdown:
                if let content = loader.itemContent ?? artifact.rawContent {
                    if Self.looksLikeHTMLDocument(content) {
                        WebArtifactView(url: Self.strippingRawQuery(currentItem.url))
                    } else {
                        MarkdownView(content: content)
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            case .image:
                if currentItem.url.pathExtension.lowercased() == "svg" {
                    WebArtifactView(url: currentItem.url)
                } else if let data = loader.itemData ?? artifact.rawData {
                    ImageView(data: data)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            case .html:
                downloadCard(
                    name: currentItem.name,
                    message: "This page is offered as a download so it does not open inside the app.",
                    url: currentItem.url
                )
            case .pdf:
                if let data = loader.itemData ?? artifact.rawData {
                    PDFArtifactView(data: data)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            case .code, .text:
                if let content = loader.itemContent ?? artifact.rawContent {
                    CodeView(content: content, language: currentItem.url.pathExtension)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            case .directory:
                DirectoryView(
                    items: artifact.items,
                    selectedItem: loader.selectedItem,
                    onSelect: { item in
                        Task { await loader.selectItem(item) }
                    }
                )
            default:
                if let content = loader.itemContent ?? artifact.rawContent, !content.isEmpty {
                    CodeView(content: content)
                } else {
                    downloadCard(
                        name: currentItem.name,
                        message: "Open this file in Safari to save or view it.",
                        url: currentItem.url
                    )
                }
            }
        } else if let content = artifact.rawContent {
            MarkdownView(content: content)
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func downloadCard(name: String, message: String, url: URL) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "arrow.down.doc.fill")
                .font(.system(size: 56))
                .foregroundColor(.secondary)
            Text(name)
                .font(.headline)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Text(message)
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button("Open in Safari") {
                UIApplication.shared.open(url)
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private static func looksLikeHTMLDocument(_ content: String) -> Bool {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.hasPrefix("<!doctype html") || trimmed.hasPrefix("<html")
    }

    private static func strippingRawQuery(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        components.queryItems = components.queryItems?.filter { $0.name != "raw" }
        if components.queryItems?.isEmpty == true {
            components.queryItems = nil
        }
        return components.url ?? url
    }

    private var appClipFooter: some View {
        VStack(spacing: 6) {
            Divider()
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("FleetLink for iOS")
                        .font(.caption.bold())
                    Text("Share files and short links")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
                Spacer()
                Button("Get App") {
                    if let url = URL(string: "https://fleetlink.online") {
                        UIApplication.shared.open(url)
                    }
                }
                .font(.caption.bold())
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(Color(UIColor.systemBackground))
        }
    }
}

public struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    public func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    public func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
