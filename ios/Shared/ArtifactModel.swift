import Foundation
import SwiftUI

public enum ArtifactKind: String, CaseIterable, Sendable {
    case markdown
    case image
    case html
    case code
    case text
    case pdf
    case directory
    case binary

    public var systemIcon: String {
        switch self {
        case .markdown: return "doc.text.fill"
        case .image: return "photo.fill"
        case .html: return "chevron.left.forwardslash.chevron.right"
        case .code: return "curlybraces"
        case .text: return "text.alignleft"
        case .pdf: return "doc.richtext.fill"
        case .directory: return "folder.fill"
        case .binary: return "doc.fill"
        }
    }

    public var displayName: String {
        switch self {
        case .markdown: return "Markdown"
        case .image: return "Image"
        case .html: return "Interactive HTML"
        case .code: return "Source Code"
        case .text: return "Plain Text"
        case .pdf: return "PDF Document"
        case .directory: return "Batch Share"
        case .binary: return "File"
        }
    }

    public static func detect(url: URL, contentType: String? = nil) -> ArtifactKind {
        let ext = url.pathExtension.lowercased()
        let type = contentType?.lowercased() ?? ""

        if type.contains("text/markdown") || ext == "md" || ext == "markdown" {
            return .markdown
        }
        if type.contains("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].contains(ext) {
            return .image
        }
        if type.contains("text/html") || ext == "html" || ext == "htm" {
            return .html
        }
        if type.contains("application/pdf") || ext == "pdf" {
            return .pdf
        }
        if ["json", "js", "ts", "py", "sh", "yaml", "yml", "xml", "css", "swift", "c", "cpp", "go", "rs", "sql", "toml"].contains(ext) ||
            type.contains("application/json") || type.contains("application/javascript") {
            return .code
        }
        if type.contains("text/plain") || ext == "txt" || ext == "log" || ext == "env" {
            return .text
        }
        return .binary
    }
}

public struct ArtifactItem: Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let relativePath: String
    public let url: URL
    public let kind: ArtifactKind
    public let size: Int64?

    public init(name: String, relativePath: String, url: URL, kind: ArtifactKind, size: Int64? = nil) {
        self.id = relativePath.isEmpty ? url.absoluteString : relativePath
        self.name = name
        self.relativePath = relativePath
        self.url = url
        self.kind = kind
        self.size = size
    }

    public var formattedSize: String? {
        guard let size = size, size > 0 else { return nil }
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useBytes, .useKB, .useMB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: size)
    }
}

public struct ShareArtifact: Identifiable, Sendable {
    public let id: String
    public let sourceURL: URL
    public let domain: String
    public let slug: String
    public let items: [ArtifactItem]
    public let isDirectory: Bool
    public let expiresAt: Date?
    public let rawContent: String?
    public let rawData: Data?

    public init(
        sourceURL: URL,
        domain: String,
        slug: String,
        items: [ArtifactItem],
        isDirectory: Bool,
        expiresAt: Date? = nil,
        rawContent: String? = nil,
        rawData: Data? = nil
    ) {
        self.id = slug
        self.sourceURL = sourceURL
        self.domain = domain
        self.slug = slug
        self.items = items
        self.isDirectory = isDirectory
        self.expiresAt = expiresAt
        self.rawContent = rawContent
        self.rawData = rawData
    }

    public var primaryItem: ArtifactItem? {
        items.first
    }
}
