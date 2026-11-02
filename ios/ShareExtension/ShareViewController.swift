import UIKit
import UniformTypeIdentifiers

/// Foreground-only, confirmed upload. The signed-in user's server permissions
/// decide destinations. No share is created while merely previewing input.
@MainActor
final class ShareViewController: UIViewController {
    private let status = UILabel()
    private let destination = UISegmentedControl(items: ["Personal", "Team"])
    private let teamButton = UIButton(type: .system)
    private let postButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)
    private var teams: [Team] = []
    private var teamID: String?
    private var parts: [Part] = []
    private var redirect: URL?
    private var ready = false
    private var uploading = false
    private var completed = false
    private var resultLink: String?
    private var credential: ShareSession.Credential?
    private let maxBytes = 20 * 1024 * 1024
    private struct Team: Decodable { let id: String; let name: String }
    private struct TeamList: Decodable { let teams: [Team] }
    private struct Part { let name: String; let type: String; let data: Data }
    private struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        preferredContentSize = CGSize(width: 420, height: 460)
        let title = UILabel()
        title.text = "Share with FleetLink"
        title.font = .preferredFont(forTextStyle: .title2)
        status.numberOfLines = 0
        status.text = "Preparing preview…"
        status.accessibilityIdentifier = "share.preview"
        destination.selectedSegmentIndex = 0
        destination.addTarget(self, action: #selector(destinationChanged), for: .valueChanged)
        teamButton.setTitle("Choose team", for: .normal)
        teamButton.showsMenuAsPrimaryAction = true
        teamButton.isHidden = true
        postButton.setTitle("Create link", for: .normal)
        postButton.isEnabled = false
        postButton.accessibilityIdentifier = "share.post"
        postButton.addTarget(self, action: #selector(post), for: .touchUpInside)
        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.addTarget(self, action: #selector(close), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [title, status, destination, teamButton, postButton, cancelButton])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48)
        ])
        Task { await prepare() }
    }

    private func prepare() async {
        do {
            credential = ShareSession.read()
            guard credential != nil else {
                throw Failure("Open FleetLink and sign in once, then share again. Nothing was uploaded.")
            }
            let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
            let providers = items.flatMap { $0.attachments ?? [] }
            guard !providers.isEmpty, providers.count <= 10 else {
                throw Failure("Share 1 to 10 files, photos, videos, web addresses or text items at a time.")
            }
            var total = 0
            for (index, provider) in providers.enumerated() {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    let item = try await loadItem(provider, type: UTType.url.identifier)
                    guard let url = item as? URL, ["https", "http"].contains(url.scheme?.lowercased() ?? "") else {
                        throw Failure("That web address is not supported.")
                    }
                    guard url.absoluteString.utf8.count <= maxBytes - total else { throw Failure("Share up to 20 MB at a time from this extension.") }
                    if providers.count == 1 { redirect = url }
                    else { parts.append(Part(name: "address-\(index + 1).txt", type: "text/plain", data: Data(url.absoluteString.utf8))) }
                } else if let type = provider.registeredTypeIdentifiers.compactMap({ UTType($0) }).first(where: {
                    $0.conforms(to: .data) && !$0.conforms(to: .text) && !$0.conforms(to: .url)
                }) {
                    let data = try await loadFile(provider, type: type.identifier, remaining: maxBytes - total)
                    let rawName = provider.suggestedName ?? "item"
                    let name = safeName(rawName, index: index, extension: type.preferredFilenameExtension)
                    parts.append(Part(name: name, type: type.preferredMIMEType ?? "application/octet-stream", data: data))
                } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    let item = try await loadItem(provider, type: UTType.fileURL.identifier)
                    guard let url = item as? URL, url.isFileURL else { throw Failure("That file could not be read.") }
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    let data = try boundedRead(url, remaining: maxBytes - total)
                    let type = UTType(filenameExtension: url.pathExtension)
                    parts.append(Part(name: safeName(url.lastPathComponent, index: index, extension: nil), type: type?.preferredMIMEType ?? "application/octet-stream", data: data))
                } else if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier) {
                    let item = try await loadItem(provider, type: UTType.text.identifier)
                    guard let text = item as? String else { throw Failure("That text could not be read.") }
                    guard text.utf8.count <= maxBytes - total else { throw Failure("Share up to 20 MB at a time from this extension.") }
                    parts.append(Part(name: "text-\(index + 1).txt", type: "text/plain; charset=utf-8", data: Data(text.utf8)))
                } else { throw Failure("One selected item is unsupported. Nothing was uploaded.") }
                total = parts.reduce(0) { $0 + $1.data.count }
                guard total <= maxBytes else { throw Failure("Share up to 20 MB at a time from this extension. Use FleetLink for larger uploads.") }
            }
            // Do not silently fall back to Personal on a failed team lookup.
            let data = try await request(path: "/api/teams")
            teams = try JSONDecoder().decode(TeamList.self, from: data).teams
            destination.setEnabled(!teams.isEmpty, forSegmentAt: 1)
            teamButton.menu = UIMenu(children: teams.map { team in
                UIAction(title: team.name) { [weak self] _ in
                    self?.teamID = team.id
                    self?.teamButton.setTitle(team.name, for: .normal)
                    self?.updatePost()
                }
            })
            status.text = redirect.map { "Web address: \($0.absoluteString)\nNew link expires in 30 days. Create a new Personal link, or choose Team." }
                ?? "\(parts.count) item(s), \(ByteCountFormatter.string(fromByteCount: Int64(total), countStyle: .file)).\n\(parts.map(\.name).joined(separator: ", "))\nNew upload expires in 3 days. Create a new Personal link, or choose Team."
            ready = true
            updatePost()
        } catch { status.text = error.localizedDescription }
    }

    private func loadItem(_ provider: NSItemProvider, type: String) async throws -> NSSecureCoding {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
                if let error { continuation.resume(throwing: error) }
                else if let item { continuation.resume(returning: item) }
                else { continuation.resume(throwing: Failure("The selected item is empty.")) }
            }
        }
    }
    private func loadFile(_ provider: NSItemProvider, type: String, remaining: Int) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                if let error { continuation.resume(throwing: error); return }
                guard let url else { continuation.resume(throwing: Failure("The selected file could not be read.")); return }
                do {
                    let handle = try FileHandle(forReadingFrom: url)
                    defer { try? handle.close() }
                    let data = try Self.readBounded(handle, remaining: remaining)
                    guard data.count <= remaining else { throw Failure("Share up to 20 MB at a time from this extension.") }
                    continuation.resume(returning: data)
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    private func boundedRead(_ url: URL, remaining: Int) throws -> Data {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try Self.readBounded(handle, remaining: remaining)
        guard data.count <= remaining else { throw Failure("Share up to 20 MB at a time from this extension.") }
        return data
    }
    // FileHandle may return fewer bytes than requested before EOF.
    private nonisolated static func readBounded(_ handle: FileHandle, remaining: Int) throws -> Data {
        var result = Data()
        while result.count <= remaining {
            let count = min(64 * 1024, max(0, remaining - result.count) + 1)
            guard let chunk = try handle.read(upToCount: count), !chunk.isEmpty else { break }
            result.append(chunk)
        }
        return result
    }
    private func safeName(_ raw: String, index: Int, extension ext: String?) -> String {
        let clean = raw.components(separatedBy: CharacterSet(charactersIn: "/\\\"\r\n")).joined(separator: "_")
        let suffix = ext.map { clean.lowercased().hasSuffix(".\($0.lowercased())") ? "" : ".\($0)" } ?? ""
        return "\(index + 1)-\(String(clean.prefix(120)))\(suffix)"
    }
    @objc private func destinationChanged() {
        teamButton.isHidden = destination.selectedSegmentIndex == 0
        updatePost()
    }
    private func updatePost() {
        postButton.isEnabled = resultLink != nil || ready && !uploading && !completed && (destination.selectedSegmentIndex == 0 || teamID != nil)
    }
    @objc private func close() {
        guard !uploading else { return }
        extensionContext?.completeRequest(returningItems: nil)
    }
    @objc private func post() {
        guard postButton.isEnabled else { return }
        if let resultLink {
            UIPasteboard.general.string = resultLink
            postButton.setTitle("Copied", for: .normal)
            return
        }
        uploading = true
        cancelButton.isEnabled = false
        destination.isEnabled = false
        teamButton.isEnabled = false
        updatePost()
        status.text = "Creating your link…"
        Task {
            do {
                let selectedTeam = destination.selectedSegmentIndex == 1 ? teamID : nil
                let data: Data
                if let redirect {
                    var payload: [String: Any] = ["url": redirect.absoluteString, "days": "30", "source": "ios-share", "team_id": selectedTeam.map { $0 as Any } ?? NSNull()]
                    if selectedTeam != nil { payload["team_access"] = "view" }
                    data = try await request(path: "/api/links", method: "POST", body: JSONSerialization.data(withJSONObject: payload), type: "application/json")
                } else {
                    let boundary = "FleetLink-\(UUID().uuidString)"
                    var body = Data()
                    func field(_ name: String, _ value: String) {
                        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
                    }
                    for part in parts {
                        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"files\"; filename=\"\(part.name)\"\r\nContent-Type: \(part.type)\r\n\r\n".utf8))
                        body.append(part.data)
                        body.append(Data("\r\n".utf8))
                    }
                    field("days", "3")
                    field("source", "ios-share")
                    // An explicit personal flag bypasses the account's default team,
                    // but only for this new, user-confirmed share.
                    if let selectedTeam { field("team_id", selectedTeam); field("team_access", "view") }
                    else { field("personal", "true") }
                    body.append(Data("--\(boundary)--\r\n".utf8))
                    data = try await request(path: "/api/shares", method: "POST", body: body, type: "multipart/form-data; boundary=\(boundary)")
                }
                guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let share = object["share"] as? [String: Any], let link = share["url"] as? String else {
                    throw Failure("The response could not be read. Check Links in FleetLink before trying again.")
                }
                completed = true
                resultLink = link
                postButton.setTitle("Copy link", for: .normal)
                parts = []
                status.text = "Link ready:\n\(link)"
                cancelButton.setTitle("Done", for: .normal)
            } catch {
                // Unknown network outcomes must not encourage a duplicate upload.
                completed = true
                status.text = "\(error.localizedDescription)\nCheck Links in FleetLink before sharing again."
            }
            uploading = false
            cancelButton.isEnabled = true
            updatePost()
        }
    }
    private func request(path: String, method: String = "GET", body: Data? = nil, type: String? = nil) async throws -> Data {
        guard let credential, ShareSession.read() == credential else {
            throw Failure("Your account or website changed. Open FleetLink, then share again.")
        }
        #if DEBUG && FLEETLINK_SHARE_FIXTURE
        if credential.token == "nonsecret-extension-qualification-fixture" {
            // No URLSession is reached for this qualification credential.
            if path == "/api/teams", method == "GET" {
                return Data(#"{"teams":[{"id":"fixture-team","name":"Fixture Team"}]}"#.utf8)
            }
            if ["/api/shares", "/api/links"].contains(path), method == "POST" {
                guard let body, !body.isEmpty else { throw Failure("Empty fixture upload.") }
                return Data(#"{"share":{"url":"https://example.invalid/qualification-result"}}"#.utf8)
            }
            throw Failure("Unsupported qualification request. Nothing was sent.")
        }
        // An opted-in fixture build must never use a real account or network.
        throw Failure("Qualification build accepts only its synthetic credential. Nothing was sent.")
        #else
        var request = URLRequest(url: credential.origin.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 90
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        request.setValue("ios", forHTTPHeaderField: "X-Fleet-Client")
        if let type { request.setValue(type, forHTTPHeaderField: "Content-Type") }
        request.httpBody = body
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure("No server response.") }
        guard (200...299).contains(http.statusCode) else {
            if http.statusCode == 401 { ShareSession.save(nil); throw Failure("Sign-in expired. Open FleetLink and sign in again.") }
            throw Failure("FleetLink could not complete this request (\(http.statusCode)). Nothing else will be sent automatically.")
        }
        return data
        #endif
    }
}
