import Foundation
import SwiftUI
import Combine

public enum ArtifactLoadState: Sendable {
    case idle
    case loading(URL)
    case loaded(ShareArtifact)
    case locked(URL)
    case redirect(from: URL, to: URL)
    case expired
    case notFound
    case failure(String)
}

/// Stops a redirect so the viewer can show where a short link goes.
private final class RedirectHalt: NSObject, URLSessionTaskDelegate {
    var nextURL: URL?

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        nextURL = request.url
        completionHandler(nil)
    }
}

@MainActor
public final class ArtifactLoader: ObservableObject {
    @Published public private(set) var state: ArtifactLoadState = .idle
    @Published public var selectedItem: ArtifactItem?
    @Published public private(set) var itemContent: String?
    @Published public private(set) var itemData: Data?
    @Published public private(set) var lockMessage: String?

    private var activePassword: String?

    public init() {}

    public func load(url: URL, password: String? = nil) async {
        let trimmedPassword = password?.trimmingCharacters(in: .whitespacesAndNewlines)
        let providedPassword = (trimmedPassword?.isEmpty == false) ? trimmedPassword : nil
        // Every load replaces the stored share password.  A later fetch must not
        // send the previous share's secret in X-Fleet-Password.
        activePassword = providedPassword
        state = .loading(url)
        selectedItem = nil
        itemContent = nil
        itemData = nil
        lockMessage = nil

        do {
            let (data, http, redirectURL) = try await fetch(url, password: activePassword)
            if let redirectURL {
                state = .redirect(from: url, to: redirectURL)
                return
            }
            if http.statusCode == 404 {
                let bodyString = String(data: data, encoding: .utf8) ?? ""
                let folded = bodyString.lowercased()
                if folded.contains("link expired") || folded.contains("has expired") {
                    state = .expired
                } else {
                    state = .notFound
                }
                return
            }
            guard (200...299).contains(http.statusCode) else {
                state = .failure("FleetLink could not open that link (error \(http.statusCode)).")
                return
            }

            let bodyString = String(data: data, encoding: .utf8) ?? ""
            if bodyString.contains("Password Required"), bodyString.contains("password") {
                if providedPassword != nil {
                    lockMessage = "That password did not unlock this link.\u{00A0} Try again."
                }
                state = .locked(url)
                return
            }

            let contentType = http.value(forHTTPHeaderField: "Content-Type") ?? ""
            let host = url.host?.lowercased() ?? "fleetlink.online"
            let pathComponents = url.pathComponents.filter { $0 != "/" && !$0.isEmpty }
            let slug = pathComponents.first ?? "share"

            // Current pages use class="file-link" and "Files in /".  Older pages
            // used "Index of /" and a document emoji in the link text.
            if contentType.contains("text/html"),
               bodyString.contains("Index of /") || bodyString.contains("class=\"file-link\"") || bodyString.contains("Files in /") {
                let items = parseDirectoryListing(html: bodyString, baseURL: url)
                let artifact = ShareArtifact(
                    sourceURL: url,
                    domain: host,
                    slug: slug,
                    items: items,
                    isDirectory: true,
                    rawContent: bodyString
                )
                state = .loaded(artifact)
                if let first = items.first {
                    await selectItem(first)
                }
                return
            }

            let fileName = pathComponents.last ?? slug
            let kind = ArtifactKind.detect(url: url, contentType: contentType)
            let item = ArtifactItem(
                name: fileName,
                relativePath: pathComponents.dropFirst().joined(separator: "/"),
                url: url,
                kind: kind,
                size: Int64(data.count)
            )
            let artifact = ShareArtifact(
                sourceURL: url,
                domain: host,
                slug: slug,
                items: [item],
                isDirectory: false,
                rawContent: bodyString.isEmpty ? nil : bodyString,
                rawData: data
            )
            state = .loaded(artifact)
            selectedItem = item
            itemContent = bodyString.isEmpty ? nil : bodyString
            itemData = data
        } catch {
            state = .failure(FleetLinkCopy.explain(error.localizedDescription))
        }
    }

    public func selectItem(_ item: ArtifactItem) async {
        selectedItem = item
        itemContent = nil
        itemData = nil

        do {
            let (data, http, redirectURL) = try await fetch(item.url, password: activePassword)
            if let redirectURL {
                state = .redirect(from: item.url, to: redirectURL)
                return
            }
            guard (200...299).contains(http.statusCode) else {
                return
            }
            if let html = String(data: data, encoding: .utf8), html.contains("Password Required"), html.contains("password") {
                state = .locked(item.url)
                return
            }
            itemData = data
            itemContent = String(data: data, encoding: .utf8)
        } catch {
            // The row stays selected.  The content area shows an empty state.
        }
    }

    private func fetch(_ url: URL, password: String?) async throws -> (Data, HTTPURLResponse, URL?) {
        var request = URLRequest(url: fetchURL(from: url))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 20
        if let password, !password.isEmpty {
            request.setValue(password, forHTTPHeaderField: "X-Fleet-Password")
        }
        let halt = RedirectHalt()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        let session = URLSession(configuration: configuration, delegate: halt, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        if (300...399).contains(http.statusCode) {
            let target = halt.nextURL ?? http.value(forHTTPHeaderField: "Location").flatMap { URL(string: $0, relativeTo: url)?.absoluteURL }
            return (data, http, target)
        }
        return (data, http, nil)
    }

    /// Notes are requested as stored text.  The rendered page stays available without this flag.
    private func fetchURL(from url: URL) -> URL {
        let ext = url.pathExtension.lowercased()
        guard ext == "md" || ext == "markdown" else { return url }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        var items = components.queryItems ?? []
        if !items.contains(where: { $0.name == "raw" }) {
            items.append(URLQueryItem(name: "raw", value: "1"))
        }
        components.queryItems = items
        return components.url ?? url
    }

    private func parseDirectoryListing(html: String, baseURL: URL) -> [ArtifactItem] {
        var items: [ArtifactItem] = []
        // Current pages use class="file-link" and a size span.  Older pages put a
        // document emoji in the link text, with or without a size label.
        let patterns = [
            #"class="file-link" href="([^"]+)">([^<]+)(?:\s*<span class="file-size">([^<]*)</span>)?</a>"#,
            #"href="([^"]+)">📄\s*([^<]+)</a>(?:\s*<span class="file-size">([^<]*)</span>)?"#
        ]
        let nsString = html as NSString
        var matches: [NSTextCheckingResult] = []
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else { continue }
            matches.append(contentsOf: regex.matches(in: html, options: [], range: NSRange(location: 0, length: nsString.length)))
        }

        for match in matches {
            guard match.numberOfRanges >= 3 else { continue }
            let href = nsString.substring(with: match.range(at: 1))
            let name = nsString.substring(with: match.range(at: 2)).trimmingCharacters(in: .whitespacesAndNewlines)
            let sizeLabel = match.numberOfRanges > 3 && match.range(at: 3).location != NSNotFound
                ? nsString.substring(with: match.range(at: 3)).trimmingCharacters(in: .whitespacesAndNewlines)
                : ""
            let size = parseByteLabel(sizeLabel)

            let fullURL: URL
            if href.starts(with: "http") {
                if let parsed = URL(string: href) { fullURL = parsed } else { continue }
            } else if href.starts(with: "/") {
                var components = URLComponents()
                components.scheme = baseURL.scheme ?? "https"
                components.host = baseURL.host ?? "fleetlink.online"
                components.path = href
                if let parsed = components.url { fullURL = parsed } else { continue }
            } else {
                fullURL = baseURL.appendingPathComponent(href)
            }

            let kind = ArtifactKind.detect(url: fullURL)
            items.append(ArtifactItem(
                name: name,
                relativePath: href,
                url: fullURL,
                kind: kind,
                size: size
            ))
        }

        return items
    }

    /// Reads the size label printed beside each name in a directory listing.
    private func parseByteLabel(_ label: String) -> Int64? {
        let parts = label.split(separator: " ")
        guard parts.count == 2, let value = Double(parts[0]), value >= 0 else { return nil }
        let multiplier: Double
        switch parts[1].uppercased() {
        case "B": multiplier = 1
        case "KB": multiplier = 1024
        case "MB": multiplier = 1024 * 1024
        case "GB": multiplier = 1024 * 1024 * 1024
        case "TB": multiplier = 1024 * 1024 * 1024 * 1024
        default: return nil
        }
        return Int64((value * multiplier).rounded())
    }
}
