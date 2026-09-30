import Foundation
import SwiftUI
import Combine

public enum ArtifactLoadState: Sendable {
    case idle
    case loading(URL)
    case loaded(ShareArtifact)
    case expired
    case notFound
    case failure(String)
}

@MainActor
public final class ArtifactLoader: ObservableObject {
    @Published public private(set) var state: ArtifactLoadState = .idle
    @Published public var selectedItem: ArtifactItem?
    @Published public private(set) var itemContent: String?
    @Published public private(set) var itemData: Data?

    public init() {}

    public func load(url: URL) async {
        state = .loading(url)
        selectedItem = nil
        itemContent = nil
        itemData = nil

        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 15

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                state = .failure("Invalid response from server.")
                return
            }

            if httpResponse.statusCode == 404 {
                let bodyString = String(data: data, encoding: .utf8) ?? ""
                if bodyString.contains("Link Expired") {
                    state = .expired
                } else {
                    state = .notFound
                }
                return
            }

            guard (200...299).contains(httpResponse.statusCode) else {
                state = .failure("Server returned error \(httpResponse.statusCode).")
                return
            }

            let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type") ?? ""
            let host = url.host?.lowercased() ?? "fleetlink.online"
            let pathComponents = url.pathComponents.filter { $0 != "/" && !$0.isEmpty }
            let slug = pathComponents.first ?? "share"

            // Check if response is a directory listing
            if contentType.contains("text/html"), let htmlString = String(data: data, encoding: .utf8), htmlString.contains("Index of /") {
                let items = parseDirectoryListing(html: htmlString, baseURL: url)
                let artifact = ShareArtifact(
                    sourceURL: url,
                    domain: host,
                    slug: slug,
                    items: items,
                    isDirectory: true,
                    rawContent: htmlString
                )
                state = .loaded(artifact)
                if let first = items.first {
                    await selectItem(first)
                }
                return
            }

            // Single file artifact
            let fileName = pathComponents.last ?? slug
            let kind = ArtifactKind.detect(url: url, contentType: contentType)
            let item = ArtifactItem(
                name: fileName,
                relativePath: pathComponents.dropFirst().joined(separator: "/"),
                url: url,
                kind: kind,
                size: Int64(data.count)
            )

            let textContent = String(data: data, encoding: .utf8)
            let artifact = ShareArtifact(
                sourceURL: url,
                domain: host,
                slug: slug,
                items: [item],
                isDirectory: false,
                rawContent: textContent,
                rawData: data
            )

            state = .loaded(artifact)
            selectedItem = item
            itemContent = textContent
            itemData = data

        } catch {
            state = .failure(error.localizedDescription)
        }
    }

    public func selectItem(_ item: ArtifactItem) async {
        selectedItem = item
        itemContent = nil
        itemData = nil

        do {
            let (data, response) = try await URLSession.shared.data(from: item.url)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                return
            }
            self.itemData = data
            self.itemContent = String(data: data, encoding: .utf8)
        } catch {
            // failed to load secondary item
        }
    }

    private func parseDirectoryListing(html: String, baseURL: URL) -> [ArtifactItem] {
        var items: [ArtifactItem] = []
        // Look for <li><a href="/...">📄 name</a></li>
        let pattern = #"href="([^"]+)">📄\s*([^<]+)</a>"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            return items
        }

        let nsString = html as NSString
        let matches = regex.matches(in: html, options: [], range: NSRange(location: 0, length: nsString.length))

        for match in matches {
            guard match.numberOfRanges == 3 else { continue }
            let href = nsString.substring(with: match.range(at: 1))
            let name = nsString.substring(with: match.range(at: 2)).trimmingCharacters(in: .whitespacesAndNewlines)

            let fullURL: URL
            if href.starts(with: "http") {
                if let u = URL(string: href) { fullURL = u } else { continue }
            } else if href.starts(with: "/") {
                var components = URLComponents()
                components.scheme = baseURL.scheme ?? "https"
                components.host = baseURL.host ?? "fleetlink.online"
                components.path = href
                if let u = components.url { fullURL = u } else { continue }
            } else {
                fullURL = baseURL.appendingPathComponent(href)
            }

            let kind = ArtifactKind.detect(url: fullURL)
            items.append(ArtifactItem(
                name: name,
                relativePath: href,
                url: fullURL,
                kind: kind
            ))
        }

        return items
    }
}
