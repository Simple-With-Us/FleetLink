import Foundation
import SwiftUI
import Combine

public struct PortalShare: Identifiable, Codable, Hashable, Sendable {
    public var id: String { slug }
    public let slug: String
    public let url: String
    public let mode: String
    public let files: Int
    public let bytes: Int64
    public let password_protected: Bool
    public let created_at: String
    public let expires_at: String
    public let renewals_used: Int?
    public let team_id: String?
    public let is_team: Bool?
    public let is_mine: Bool?
    public let target_url: String?

    public var isRedirect: Bool {
        mode == "redirect"
    }

    public var formattedBytes: String {
        if isRedirect { return "Short link" }
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024.0
        if kb < 1024.0 { return String(format: "%.1f KB", kb) }
        let mb = kb / 1024.0
        if mb < 1024.0 { return String(format: "%.1f MB", mb) }
        let gb = mb / 1024.0
        return String(format: "%.2f GB", gb)
    }

    private static let iso8601Fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let iso8601Standard: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    public var createdDate: Date? {
        Self.iso8601Fractional.date(from: created_at) ?? Self.iso8601Standard.date(from: created_at)
    }

    public var expiresDate: Date? {
        Self.iso8601Fractional.date(from: expires_at) ?? Self.iso8601Standard.date(from: expires_at)
    }

    public var timeRemainingString: String {
        if expires_at == "never" || expires_at.isEmpty { return "Until you delete it" }
        guard let exp = expiresDate else { return "Time unavailable" }
        let remaining = exp.timeIntervalSinceNow
        if remaining <= 0 { return "Expired" }
        let days = Int(remaining / 86400)
        let hours = Int((remaining.truncatingRemainder(dividingBy: 86400)) / 3600)
        if days > 0 {
            return "\(days) \(days == 1 ? "day" : "days"), \(hours) \(hours == 1 ? "hour" : "hours")"
        }
        let mins = Int((remaining.truncatingRemainder(dividingBy: 3600)) / 60)
        if hours > 0 {
            return "\(hours) \(hours == 1 ? "hour" : "hours"), \(mins) \(mins == 1 ? "minute" : "minutes")"
        }
        return "\(mins) \(mins == 1 ? "minute" : "minutes")"
    }

    public var isExpiringSoon: Bool {
        guard let exp = expiresDate else { return false }
        let remaining = exp.timeIntervalSinceNow
        return remaining > 0 && remaining < 86400 // under 24 hours
    }
}

public struct PortalSharesResponse: Codable, Sendable {
    public let shares: [PortalShare]
}

public struct PortalAnalytics: Sendable {
    public let totalShares: Int
    public let totalFiles: Int
    public let totalBytes: Int64
    public let totalRedirects: Int
    public let totalFileShares: Int
    public let expiringSoonCount: Int
    public let passwordProtectedCount: Int

    public var formattedTotalBytes: String {
        if totalBytes < 1024 { return "\(totalBytes) B" }
        let kb = Double(totalBytes) / 1024.0
        if kb < 1024.0 { return String(format: "%.1f KB", kb) }
        let mb = kb / 1024.0
        if mb < 1024.0 { return String(format: "%.1f MB", mb) }
        let gb = mb / 1024.0
        return String(format: "%.2f GB", gb)
    }
}

public enum FleetLinkCopy {
    public static func explain(_ message: String) -> String {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "Something went wrong.\u{00A0} Try again." }
        let lower = trimmed.lowercased()
        if lower.contains("authentication required") || lower.contains("invalid secret") || lower.contains("unauthorized") {
            return "Sign in before you continue.\u{00A0} Add your sign-in code in Settings."
        }
        if lower.contains("invalid url") || lower.contains("invalid endpoint") {
            return "That web address is not valid."
        }
        return trimmed
            .replacingOccurrences(of: "Cloudflare R2", with: "storage", options: .caseInsensitive)
            .replacingOccurrences(of: "R2", with: "storage")
            .replacingOccurrences(of: "system asset", with: "site file", options: .caseInsensitive)
            .replacingOccurrences(of: "slug", with: "link name", options: .caseInsensitive)
            .replacingOccurrences(of: "TTL", with: "time limit")
    }
}

public struct UploadPart: Sendable {
    public let fileName: String
    public let content: Data
    public let mimeType: String

    public init(fileName: String, content: Data, mimeType: String) {
        self.fileName = fileName
        self.content = content
        self.mimeType = mimeType
    }
}

public enum PortalError: LocalizedError, Sendable {
    case invalidURL
    case unauthorized
    case serverError(String)
    case encodingFailed

    public var errorDescription: String? {
        switch self {
        case .invalidURL: return "That web address is not valid."
        case .unauthorized: return "Sign in before you continue.\u{00A0} Add your sign-in code in Settings."
        case .serverError(let message): return FleetLinkCopy.explain(message)
        case .encodingFailed: return "That text could not be saved.\u{00A0} Try again."
        }
    }
}

private struct LocalShareRecord: Codable {
    var slug: String
    var url: String
    var mode: String
    var files: Int
    var bytes: Int64
    var passwordProtected: Bool
    var createdAt: String
    var expiresAt: String
    var renewalsUsed: Int?
    var targetURL: String?
    var host: String
}

private struct BucketOverview: Decodable {
    let slugs: [BucketSlug]
}

private struct BucketSlug: Decodable {
    let slug: String
    let isBatch: Bool?
    let isSystemAsset: Bool?
    let isRedirect: Bool?
    let targetUrl: String?
    let fileCount: Int?
    let totalBytes: Int64?
    let expireAt: Double?
    let isPasswordProtected: Bool?
    let createdAt: Double?
    let renewals_used: Int?
}

@MainActor
public final class PortalManager: ObservableObject {
    @Published public private(set) var shares: [PortalShare] = []
    @Published public private(set) var isLoading: Bool = false
    @Published public private(set) var errorMessage: String?
    @Published public private(set) var analytics: PortalAnalytics = PortalAnalytics(
        totalShares: 0,
        totalFiles: 0,
        totalBytes: 0,
        totalRedirects: 0,
        totalFileShares: 0,
        expiringSoonCount: 0,
        passwordProtectedCount: 0
    )

    private let ledgerKey = "fl_local_shares_v1"

    public init() {}

    public func fetchShares(host: String = "https://fleetlink.online", token: String = "", sessionCookie: String? = nil) async {
        isLoading = true
        errorMessage = nil
        let local = localShares(host: host)
        shares = local
        computeAnalytics()

        guard let url = URL(string: "\(normalizedHost(host))/api/portal/data") else {
            errorMessage = "That server address is not valid."
            isLoading = false
            return
        }
        var request = authorizedRequest(url: url, method: "GET", token: token, sessionCookie: sessionCookie)
        request.cachePolicy = .reloadIgnoringLocalCacheData

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                errorMessage = "FleetLink sent a response the app could not read."
                isLoading = false
                return
            }
            if http.statusCode == 401 || http.statusCode == 403 {
                shares = local
                computeAnalytics()
                if local.isEmpty {
                    errorMessage = "Sign in to see every link.\u{00A0} Links you make on this device stay in this list."
                }
                isLoading = false
                return
            }
            guard (200...299).contains(http.statusCode) else {
                shares = local
                computeAnalytics()
                errorMessage = "Could not load links."
                isLoading = false
                return
            }
            let overview = try JSONDecoder().decode(BucketOverview.self, from: data)
            var merged: [String: PortalShare] = [:]
            for slug in overview.slugs where slug.isSystemAsset != true {
                merged[slug.slug] = share(from: slug, host: host)
            }
            for item in local where merged[item.slug] == nil {
                merged[item.slug] = item
            }
            shares = merged.values.sorted { ($0.createdDate ?? .distantPast) > ($1.createdDate ?? .distantPast) }
            computeAnalytics()
            isLoading = false
        } catch {
            shares = local
            computeAnalytics()
            errorMessage = "Could not load links.\u{00A0} Links saved on this device are still shown."
            isLoading = false
        }
    }

    public func deleteShare(slug: String, host: String = "https://fleetlink.online", token: String = "", sessionCookie: String? = nil) async -> Bool {
        guard let url = URL(string: "\(normalizedHost(host))/api/portal/delete") else { return false }
        var request = authorizedRequest(url: url, method: "POST", token: token, sessionCookie: sessionCookie)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["slug": slug])

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                errorMessage = FleetLinkCopy.explain(serverMessage(from: data, fallback: "Could not delete that link."))
                return false
            }
            shares.removeAll { $0.slug == slug }
            removeRecord(slug: slug, host: host)
            computeAnalytics()
            return true
        } catch {
            errorMessage = "Could not delete that link.\u{00A0} Check the connection and try again."
            return false
        }
    }

    public func renewShare(slug: String, host: String = "https://fleetlink.online", token: String = "", sessionCookie: String? = nil) async -> Bool {
        guard let url = URL(string: "\(normalizedHost(host))/api/portal/renew") else { return false }
        var request = authorizedRequest(url: url, method: "POST", token: token, sessionCookie: sessionCookie)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["slug": slug])

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                errorMessage = FleetLinkCopy.explain(serverMessage(from: data, fallback: "Could not renew that link."))
                return false
            }
            if let json = jsonObject(data), let current = shares.first(where: { $0.slug == slug }) {
                let updated = updatedShare(current, json: json)
                shares = shares.map { $0.slug == slug ? updated : $0 }
                remember(updated, host: host)
                computeAnalytics()
            } else {
                await fetchShares(host: host, token: token, sessionCookie: sessionCookie)
            }
            return true
        } catch {
            errorMessage = "Could not renew that link.\u{00A0} Check the connection and try again."
            return false
        }
    }

    public func createRedirect(
        targetUrl: String,
        customSlug: String? = nil,
        ttlSeconds: Int = 15552000,
        password: String? = nil,
        title: String? = nil,
        description: String? = nil,
        domain: String = "fleetlink.online",
        host: String = "https://fleetlink.online",
        token: String = "",
        sessionCookie: String? = nil
    ) async -> Result<String, PortalError> {
        let apiHost = normalizedHost(host.isEmpty ? "https://\(domain)" : host)
        guard let url = URL(string: "\(apiHost)/api/redirect") else {
            return .failure(.invalidURL)
        }
        var payload: [String: String] = [
            "target_url": targetUrl.trimmingCharacters(in: .whitespacesAndNewlines),
            "days": daysValue(ttlSeconds)
        ]
        if let slug = cleaned(customSlug) { payload["slug"] = slug }
        if let password = cleaned(password) { payload["password"] = password }
        if let title = cleaned(title) { payload["title"] = title }
        if let description = cleaned(description) { payload["description"] = description }
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedToken.isEmpty { payload["secret"] = trimmedToken }

        var request = authorizedRequest(url: url, method: "POST", token: token, sessionCookie: sessionCookie)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        return await finishCreate(request, host: apiHost, token: token, sessionCookie: sessionCookie, mode: "redirect", fileCount: 1, bytes: 0, passwordProtected: cleaned(password) != nil, targetURL: payload["target_url"])
    }

    public func createUpload(
        files: [UploadPart],
        customSlug: String? = nil,
        ttlSeconds: Int = 259200,
        password: String? = nil,
        title: String? = nil,
        description: String? = nil,
        preview: UploadPart? = nil,
        domain: String = "fleetlink.online",
        host: String = "https://fleetlink.online",
        token: String = "",
        sessionCookie: String? = nil
    ) async -> Result<String, PortalError> {
        let ready = files.filter { !$0.content.isEmpty }
        guard !ready.isEmpty else { return .failure(.encodingFailed) }
        let apiHost = normalizedHost(host.isEmpty ? "https://\(domain)" : host)
        guard let url = URL(string: "\(apiHost)/api/upload") else {
            return .failure(.invalidURL)
        }

        let boundary = "Boundary-\(UUID().uuidString)"
        var request = authorizedRequest(url: url, method: "POST", token: token, sessionCookie: sessionCookie)
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        func addField(_ name: String, _ value: String) {
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".utf8))
            body.append(Data(value.utf8))
            body.append(Data("\r\n".utf8))
        }
        func addFile(_ part: UploadPart, field: String) {
            let name = safeFileName(part.fileName)
            let mime = part.mimeType.isEmpty ? "application/octet-stream" : part.mimeType
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"\(field)\"; filename=\"\(name)\"\r\n".utf8))
            body.append(Data("Content-Type: \(mime)\r\n\r\n".utf8))
            body.append(part.content)
            body.append(Data("\r\n".utf8))
        }

        for part in ready { addFile(part, field: "files") }
        if let preview, !preview.content.isEmpty { addFile(preview, field: "preview_image") }
        addField("days", daysValue(ttlSeconds))
        if let slug = cleaned(customSlug) { addField("slug", slug) }
        if let password = cleaned(password) { addField("password", password) }
        if let title = cleaned(title) { addField("title", title) }
        if let description = cleaned(description) { addField("description", description) }
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedToken.isEmpty { addField("secret", trimmedToken) }
        body.append(Data("--\(boundary)--\r\n".utf8))
        request.httpBody = body

        let totalBytes = ready.reduce(Int64(0)) { $0 + Int64($1.content.count) }
        return await finishCreate(request, host: apiHost, token: token, sessionCookie: sessionCookie, mode: "files", fileCount: ready.count, bytes: totalBytes, passwordProtected: cleaned(password) != nil, targetURL: nil)
    }

    public func createUpload(
        fileName: String,
        content: Data,
        customSlug: String? = nil,
        ttlSeconds: Int = 259200,
        password: String? = nil,
        domain: String = "fleetlink.online",
        host: String = "https://fleetlink.online",
        token: String = ""
    ) async -> Result<String, PortalError> {
        let mime = mimeType(for: fileName)
        return await createUpload(
            files: [UploadPart(fileName: fileName, content: content, mimeType: mime)],
            customSlug: customSlug,
            ttlSeconds: ttlSeconds,
            password: password,
            domain: domain,
            host: host,
            token: token
        )
    }

    private func finishCreate(
        _ request: URLRequest,
        host: String,
        token: String,
        sessionCookie: String?,
        mode: String,
        fileCount: Int,
        bytes: Int64,
        passwordProtected: Bool,
        targetURL: String?
    ) async -> Result<String, PortalError> {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return .failure(.serverError("FleetLink sent a response the app could not read."))
            }
            let json = jsonObject(data)
            if let createdURL = json?["url"] as? String, (200...299).contains(http.statusCode) {
                let slug = (json?["slug"] as? String) ?? URL(string: createdURL)?.pathComponents.dropFirst().first ?? ""
                let expires = expiresString(from: json)
                let share = PortalShare(
                    slug: slug,
                    url: createdURL,
                    mode: mode,
                    files: (json?["count"] as? Int) ?? fileCount,
                    bytes: bytes,
                    password_protected: passwordProtected,
                    created_at: Self.isoString(from: Date()),
                    expires_at: expires,
                    renewals_used: 0,
                    team_id: nil,
                    is_team: nil,
                    is_mine: true,
                    target_url: (json?["target_url"] as? String) ?? targetURL
                )
                remember(share, host: host)
                await fetchShares(host: host, token: token, sessionCookie: sessionCookie)
                return .success(createdURL)
            }
            if http.statusCode == 401 || http.statusCode == 403 {
                return .failure(.unauthorized)
            }
            if let message = json?["error"] as? String, !message.isEmpty {
                return .failure(.serverError(message))
            }
            return .failure(.serverError(serverMessage(from: data, fallback: "The link could not be created.")))
        } catch {
            return .failure(.serverError("The link could not be created.\u{00A0} Check the connection and try again."))
        }
    }

    private func computeAnalytics() {
        let totalShares = shares.count
        let totalFiles = shares.reduce(0) { $0 + $1.files }
        let totalBytes = shares.reduce(Int64(0)) { $0 + $1.bytes }
        let totalRedirects = shares.filter { $0.isRedirect }.count
        let totalFileShares = shares.filter { !$0.isRedirect }.count
        analytics = PortalAnalytics(
            totalShares: totalShares,
            totalFiles: totalFiles,
            totalBytes: totalBytes,
            totalRedirects: totalRedirects,
            totalFileShares: totalFileShares,
            expiringSoonCount: shares.filter { $0.isExpiringSoon }.count,
            passwordProtectedCount: shares.filter { $0.password_protected }.count
        )
    }

    private func authorizedRequest(url: URL, method: String, token: String, sessionCookie: String?) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            request.setValue("Bearer \(trimmed)", forHTTPHeaderField: "Authorization")
        }
        if let sessionCookie, !sessionCookie.isEmpty {
            request.setValue(sessionCookie, forHTTPHeaderField: "Cookie")
        }
        return request
    }

    private func share(from slug: BucketSlug, host: String) -> PortalShare {
        let root = normalizedHost(host)
        let suffix = (slug.isBatch == true && slug.isRedirect != true) ? "/" : ""
        let expires = slug.expireAt.flatMap { $0 > 0 ? Self.isoString(fromMilliseconds: $0) : nil } ?? "never"
        let created = slug.createdAt.flatMap { $0 > 0 ? Self.isoString(fromMilliseconds: $0) : nil } ?? Self.isoString(from: Date())
        return PortalShare(
            slug: slug.slug,
            url: "\(root)/\(slug.slug)\(suffix)",
            mode: slug.isRedirect == true ? "redirect" : "files",
            files: slug.fileCount ?? 1,
            bytes: slug.totalBytes ?? 0,
            password_protected: slug.isPasswordProtected ?? false,
            created_at: created,
            expires_at: expires,
            renewals_used: slug.renewals_used,
            team_id: nil,
            is_team: nil,
            is_mine: true,
            target_url: slug.targetUrl
        )
    }

    private func updatedShare(_ share: PortalShare, json: [String: Any]) -> PortalShare {
        PortalShare(
            slug: share.slug,
            url: share.url,
            mode: share.mode,
            files: share.files,
            bytes: share.bytes,
            password_protected: share.password_protected,
            created_at: share.created_at,
            expires_at: expiresString(from: json),
            renewals_used: (json["renewals_used"] as? Int) ?? (json["renewals_used"] as? NSNumber)?.intValue ?? share.renewals_used,
            team_id: share.team_id,
            is_team: share.is_team,
            is_mine: share.is_mine,
            target_url: share.target_url
        )
    }

    private func localShares(host: String) -> [PortalShare] {
        let wanted = normalizedHost(host)
        return loadRecords().compactMap { record in
            guard normalizedHost(record.host) == wanted else { return nil }
            return PortalShare(
                slug: record.slug,
                url: record.url,
                mode: record.mode,
                files: record.files,
                bytes: record.bytes,
                password_protected: record.passwordProtected,
                created_at: record.createdAt,
                expires_at: record.expiresAt,
                renewals_used: record.renewalsUsed,
                team_id: nil,
                is_team: nil,
                is_mine: true,
                target_url: record.targetURL
            )
        }
    }

    private func remember(_ share: PortalShare, host: String) {
        var records = loadRecords().filter { !($0.slug == share.slug && normalizedHost($0.host) == normalizedHost(host)) }
        records.insert(LocalShareRecord(
            slug: share.slug,
            url: share.url,
            mode: share.mode,
            files: share.files,
            bytes: share.bytes,
            passwordProtected: share.password_protected,
            createdAt: share.created_at,
            expiresAt: share.expires_at,
            renewalsUsed: share.renewals_used,
            targetURL: share.target_url,
            host: normalizedHost(host)
        ), at: 0)
        if records.count > 100 { records = Array(records.prefix(100)) }
        saveRecords(records)
    }

    private func removeRecord(slug: String, host: String) {
        let records = loadRecords().filter { !($0.slug == slug && normalizedHost($0.host) == normalizedHost(host)) }
        saveRecords(records)
    }

    private func loadRecords() -> [LocalShareRecord] {
        guard let data = UserDefaults.standard.data(forKey: ledgerKey) else { return [] }
        return (try? JSONDecoder().decode([LocalShareRecord].self, from: data)) ?? []
    }

    private func saveRecords(_ records: [LocalShareRecord]) {
        if let data = try? JSONEncoder().encode(records) {
            UserDefaults.standard.set(data, forKey: ledgerKey)
        }
    }

    private func normalizedHost(_ host: String) -> String {
        var value = host.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") { value.removeLast() }
        if !value.hasPrefix("http://") && !value.hasPrefix("https://") {
            value = "https://\(value)"
        }
        return value
    }

    private func cleaned(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func daysValue(_ seconds: Int) -> String {
        if seconds <= 0 { return "forever" }
        let days = Double(seconds) / 86_400
        if days >= 1, abs(days - days.rounded()) < 0.001 {
            return String(Int(days.rounded()))
        }
        return String(format: "%.4f", days)
    }

    private func safeFileName(_ name: String) -> String {
        let cleaned = name
            .replacingOccurrences(of: "\"", with: "")
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "file.bin" : cleaned
    }

    private func mimeType(for fileName: String) -> String {
        let lower = fileName.lowercased()
        if lower.hasSuffix(".md") || lower.hasSuffix(".markdown") { return "text/markdown" }
        if lower.hasSuffix(".txt") || lower.hasSuffix(".log") { return "text/plain" }
        if lower.hasSuffix(".json") { return "application/json" }
        if lower.hasSuffix(".html") || lower.hasSuffix(".htm") { return "text/html" }
        if lower.hasSuffix(".png") { return "image/png" }
        if lower.hasSuffix(".jpg") || lower.hasSuffix(".jpeg") { return "image/jpeg" }
        if lower.hasSuffix(".gif") { return "image/gif" }
        if lower.hasSuffix(".webp") { return "image/webp" }
        if lower.hasSuffix(".pdf") { return "application/pdf" }
        return "application/octet-stream"
    }

    private func jsonObject(_ data: Data) -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func serverMessage(from data: Data, fallback: String) -> String {
        if let message = jsonObject(data)?["error"] as? String, !message.isEmpty {
            return FleetLinkCopy.explain(message)
        }
        return FleetLinkCopy.explain(fallback)
    }

    private func expiresString(from json: [String: Any]?) -> String {
        if let number = json?["expire_at"] as? NSNumber, number.doubleValue > 0 {
            return Self.isoString(fromMilliseconds: number.doubleValue)
        }
        if let text = json?["expires"] as? String {
            if text == "Never" || text == "never" { return "never" }
            if !text.isEmpty { return text }
        }
        return "never"
    }

    private static func isoString(from date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func isoString(fromMilliseconds ms: Double) -> String {
        isoString(from: Date(timeIntervalSince1970: ms / 1000))
    }
}
