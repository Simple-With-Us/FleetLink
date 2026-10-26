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
    public let title: String?
    public let description: String?
    public let can_manage: Bool?
    public let can_edit: Bool?
    public let team_name: String?
    public let team_access: String?
    public let owner_name: String?

    public init(
        slug: String,
        url: String,
        mode: String,
        files: Int,
        bytes: Int64,
        password_protected: Bool,
        created_at: String,
        expires_at: String,
        renewals_used: Int? = nil,
        team_id: String? = nil,
        is_team: Bool? = nil,
        is_mine: Bool? = nil,
        target_url: String? = nil,
        title: String? = nil,
        description: String? = nil,
        can_manage: Bool? = nil,
        can_edit: Bool? = nil,
        team_name: String? = nil,
        team_access: String? = nil,
        owner_name: String? = nil
    ) {
        self.slug = slug
        self.url = url
        self.mode = mode
        self.files = files
        self.bytes = bytes
        self.password_protected = password_protected
        self.created_at = created_at
        self.expires_at = expires_at
        self.renewals_used = renewals_used
        self.team_id = team_id
        self.is_team = is_team
        self.is_mine = is_mine
        self.target_url = target_url
        self.title = title
        self.description = description
        self.can_manage = can_manage
        self.can_edit = can_edit
        self.team_name = team_name
        self.team_access = team_access
        self.owner_name = owner_name
    }

    public var isRedirect: Bool {
        mode == "redirect"
    }

    public var isFilesShare: Bool {
        mode == "files"
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

public struct PortalShareFile: Identifiable, Codable, Hashable, Sendable {
    public var id: String { path }
    public let path: String
    public let size: Int64
    public let content_type: String?
    public let url: String?

    public var fileName: String { path.split(separator: "/").last.map(String.init) ?? path }

    public var formattedSize: String {
        if size < 1024 { return "\(size) B" }
        let kb = Double(size) / 1024
        if kb < 1024 { return String(format: "%.1f KB", kb) }
        let mb = kb / 1024
        if mb < 1024 { return String(format: "%.1f MB", mb) }
        return String(format: "%.1f GB", mb / 1024)
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
            return "Sign in before you continue.\u{00A0} Use your passkey in Settings."
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
        case .unauthorized: return "Sign in before you continue.\u{00A0} Use your passkey in Settings."
        case .serverError(let message): return FleetLinkCopy.explain(message)
        case .encodingFailed: return "That text could not be saved.\u{00A0} Try again."
        }
    }
}

/// A share as the account API returns it (`GET /api/shares`, `GET /api/shares/:slug`).
private struct ApiShareDetailEnvelope: Decodable {
    struct Detail: Decodable {
        let files: [PortalShareFile]?
    }
    let share: Detail
}

private struct ApiShare: Decodable {
    struct Team: Decodable {
        let id: String
        let name: String?
        let access: String?
    }
    struct Owner: Decodable {
        let id: String
        let display_name: String?
    }
    let slug: String
    let url: String
    let kind: String
    let target_url: String?
    let title: String?
    let description: String?
    let has_password: Bool
    let file_count: Int
    let total_bytes: Int64
    let renewals: Int
    let created_at: String
    let expires_at: String?
    let can_manage: Bool?
    let can_edit: Bool?
    let owner: Owner?
    let team: Team?
}

public struct PortalTeam: Identifiable, Codable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let my_role: String?

    public init(id: String, name: String, my_role: String? = nil) {
        self.id = id
        self.name = name
        self.my_role = my_role
    }
}

private struct ApiTeamsResponse: Decodable {
    let teams: [PortalTeam]
}

private struct ApiShareList: Decodable { let shares: [ApiShare] }
private struct ApiShareEnvelope: Decodable { let share: ApiShare }

@MainActor
public final class PortalManager: ObservableObject {
    @Published public private(set) var shares: [PortalShare] = []
    @Published public private(set) var teams: [PortalTeam] = []
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

    /// The ledger the app kept before shares had owners.  It is cleared once.
    private let legacyLedgerKey = "fl_local_shares_v1"

    public init() {
        UserDefaults.standard.removeObject(forKey: legacyLedgerKey)
    }

    /// Load the signed-in account's live shares.  `token` is the passkey session.
    public func fetchShares(host: String = "https://fleetlink.online", token: String = "") async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        guard !token.isEmpty else {
            shares = []
            computeAnalytics()
            errorMessage = "Sign in with your passkey in Settings to see your links."
            return
        }
        guard let url = URL(string: "\(normalizedHost(host))/api/shares?scope=mine&limit=200") else {
            errorMessage = "That server address is not valid."
            return
        }
        do {
            let (data, http) = try await send(authorizedRequest(url: url, method: "GET", token: token))
            if http.statusCode == 401 || http.statusCode == 403 {
                shares = []
                computeAnalytics()
                errorMessage = "Your sign-in has ended.\u{00A0} Sign in again in Settings."
                return
            }
            guard (200...299).contains(http.statusCode) else {
                errorMessage = serverMessage(from: data, fallback: "Could not load links.")
                return
            }
            let list = try JSONDecoder().decode(ApiShareList.self, from: data)
            shares = list.shares.map(Self.portalShare)
            computeAnalytics()
        } catch {
            errorMessage = "Could not load links.\u{00A0} Check the connection and try again."
        }
    }

    public func deleteShare(slug: String, host: String = "https://fleetlink.online", token: String = "") async -> Bool {
        guard let url = URL(string: "\(normalizedHost(host))/api/shares/\(Self.pathSegment(slug))") else { return false }
        do {
            let (data, http) = try await send(authorizedRequest(url: url, method: "DELETE", token: token))
            guard (200...299).contains(http.statusCode) else {
                errorMessage = serverMessage(from: data, fallback: "Could not delete that link.")
                return false
            }
            shares.removeAll { $0.slug == slug }
            computeAnalytics()
            return true
        } catch {
            errorMessage = "Could not delete that link.\u{00A0} Check the connection and try again."
            return false
        }
    }

    public func renewShare(slug: String, host: String = "https://fleetlink.online", token: String = "") async -> Bool {
        guard let url = URL(string: "\(normalizedHost(host))/api/shares/\(Self.pathSegment(slug))/renew") else { return false }
        var request = authorizedRequest(url: url, method: "POST", token: token)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        do {
            let (data, http) = try await send(request)
            guard (200...299).contains(http.statusCode) else {
                errorMessage = serverMessage(from: data, fallback: "Could not renew that link.")
                return false
            }
            if let envelope = try? JSONDecoder().decode(ApiShareEnvelope.self, from: data) {
                let updated = Self.portalShare(envelope.share)
                shares = shares.map { $0.slug == slug ? updated : $0 }
                computeAnalytics()
            }
            return true
        } catch {
            errorMessage = "Could not renew that link.\u{00A0} Check the connection and try again."
            return false
        }
    }

    public func renameShare(slug: String, newSlug: String, host: String = "https://fleetlink.online", token: String = "") async -> Bool {
        guard let url = URL(string: "\(normalizedHost(host))/api/shares/\(Self.pathSegment(slug))") else { return false }
        var request = authorizedRequest(url: url, method: "PATCH", token: token)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload = ["slug": newSlug.trimmingCharacters(in: .whitespacesAndNewlines)]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return false }
        request.httpBody = body
        do {
            let (data, http) = try await send(request)
            guard (200...299).contains(http.statusCode) else {
                errorMessage = serverMessage(from: data, fallback: "Could not rename link.")
                return false
            }
            if let envelope = try? JSONDecoder().decode(ApiShareEnvelope.self, from: data) {
                let updated = Self.portalShare(envelope.share)
                shares = shares.map { $0.slug == slug ? updated : $0 }
                computeAnalytics()
            }
            return true
        } catch {
            errorMessage = "Could not rename link.\u{00A0} Check the connection and try again."
            return false
        }
    }

    public func extendShare(slug: String, days: String, host: String = "https://fleetlink.online", token: String = "") async -> Bool {
        guard let url = URL(string: "\(normalizedHost(host))/api/shares/\(Self.pathSegment(slug))/renew") else { return false }
        var request = authorizedRequest(url: url, method: "POST", token: token)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload = ["days": days.trimmingCharacters(in: .whitespacesAndNewlines)]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return false }
        request.httpBody = body
        do {
            let (data, http) = try await send(request)
            guard (200...299).contains(http.statusCode) else {
                errorMessage = serverMessage(from: data, fallback: "Could not extend link.")
                return false
            }
            if let envelope = try? JSONDecoder().decode(ApiShareEnvelope.self, from: data) {
                let updated = Self.portalShare(envelope.share)
                shares = shares.map { $0.slug == slug ? updated : $0 }
                computeAnalytics()
            }
            return true
        } catch {
            errorMessage = "Could not extend link.\u{00A0} Check the connection and try again."
            return false
        }
    }

    public func updateShareAccess(
        slug: String,
        teamId: String?,
        teamAccess: String? = "edit",
        password: String? = nil,
        clearPassword: Bool = false,
        title: String? = nil,
        description: String? = nil,
        url: String? = nil,
        host: String = "https://fleetlink.online",
        token: String = ""
    ) async -> Bool {
        guard let requestURL = URL(string: "\(normalizedHost(host))/api/shares/\(Self.pathSegment(slug))") else { return false }
        var request = authorizedRequest(url: requestURL, method: "PATCH", token: token)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var payload: [String: Any] = [:]
        if let teamId = teamId, !teamId.isEmpty {
            payload["team_id"] = teamId
            payload["team_access"] = teamAccess ?? "edit"
        } else {
            payload["team_id"] = NSNull()
        }
        if clearPassword {
            payload["password"] = NSNull()
        } else if let password = password, !password.isEmpty {
            payload["password"] = password
        }
        if let title = title { payload["title"] = title }
        if let description = description { payload["description"] = description }
        if let destination = url { payload["url"] = destination }
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return false }
        request.httpBody = body
        do {
            let (data, http) = try await send(request)
            guard (200...299).contains(http.statusCode) else {
                errorMessage = serverMessage(from: data, fallback: "Could not update link access.")
                return false
            }
            if let envelope = try? JSONDecoder().decode(ApiShareEnvelope.self, from: data) {
                let updated = Self.portalShare(envelope.share)
                shares = shares.map { $0.slug == slug ? updated : $0 }
                computeAnalytics()
            }
            return true
        } catch {
            errorMessage = "Could not update link access.\u{00A0} Check the connection and try again."
            return false
        }
    }

    public func fetchShareFiles(slug: String, host: String = "https://fleetlink.online", token: String = "") async -> [PortalShareFile]? {
        guard let url = URL(string: "\(normalizedHost(host))/api/shares/\(Self.pathSegment(slug))") else { return nil }
        do {
            let (data, http) = try await send(authorizedRequest(url: url, method: "GET", token: token))
            guard (200...299).contains(http.statusCode) else { return nil }
            let envelope = try JSONDecoder().decode(ApiShareDetailEnvelope.self, from: data)
            return envelope.share.files ?? []
        } catch { return nil }
    }

    public func removeShareFile(slug: String, path: String, host: String = "https://fleetlink.online", token: String = "") async -> Bool {
        let encoded = path.split(separator: "/").map { Self.pathSegment(String($0)) }.joined(separator: "/")
        guard let url = URL(string: "\(normalizedHost(host))/api/shares/\(Self.pathSegment(slug))/files/\(encoded)") else { return false }
        do {
            let (data, http) = try await send(authorizedRequest(url: url, method: "DELETE", token: token))
            guard (200...299).contains(http.statusCode) else {
                errorMessage = serverMessage(from: data, fallback: "Could not remove the file.")
                return false
            }
            if let envelope = try? JSONDecoder().decode(ApiShareEnvelope.self, from: data) {
                let updated = Self.portalShare(envelope.share)
                shares = shares.map { $0.slug == slug ? updated : $0 }
                computeAnalytics()
            }
            return true
        } catch {
            errorMessage = "Could not remove the file.\u{00A0} Check the connection and try again."
            return false
        }
    }

    public func addShareFile(slug: String, fileURL: URL, host: String = "https://fleetlink.online", token: String = "") async -> Bool {
        let accessing = fileURL.startAccessingSecurityScopedResource()
        defer { if accessing { fileURL.stopAccessingSecurityScopedResource() } }
        guard let stream = InputStream(url: fileURL), let size = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]))?.fileSize else {
            errorMessage = "Could not read that file."
            return false
        }
        let name = fileURL.lastPathComponent
        guard let url = URL(string: "\(normalizedHost(host))/api/shares/\(Self.pathSegment(slug))/files/\(Self.pathSegment(name))") else { return false }
        var request = authorizedRequest(url: url, method: "PUT", token: token)
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(String(size), forHTTPHeaderField: "Content-Length")
        request.httpBodyStream = stream
        do {
            let (responseData, http) = try await send(request)
            guard (200...299).contains(http.statusCode) else {
                errorMessage = serverMessage(from: responseData, fallback: "Could not add the file.")
                return false
            }
            if let envelope = try? JSONDecoder().decode(ApiShareEnvelope.self, from: responseData) {
                let updated = Self.portalShare(envelope.share)
                shares = shares.map { $0.slug == slug ? updated : $0 }
                computeAnalytics()
            }
            return true
        } catch {
            errorMessage = "Could not add the file.\u{00A0} Check the connection and try again."
            return false
        }
    }

    public func fetchTeams(host: String = "https://fleetlink.online", token: String = "") async {
        guard !token.isEmpty, let url = URL(string: "\(normalizedHost(host))/api/teams") else { return }
        do {
            let (data, http) = try await send(authorizedRequest(url: url, method: "GET", token: token))
            guard (200...299).contains(http.statusCode) else { return }
            let res = try JSONDecoder().decode(ApiTeamsResponse.self, from: data)
            teams = res.teams
        } catch {}
    }

    public func createRedirect(
        targetUrl: String,
        customSlug: String? = nil,
        ttlSeconds: Int = 2592000,
        password: String? = nil,
        title: String? = nil,
        description: String? = nil,
        domain: String = "fleetlink.online",
        host: String = "https://fleetlink.online",
        token: String = ""
    ) async -> Result<String, PortalError> {
        let apiHost = normalizedHost(host.isEmpty ? "https://\(domain)" : host)
        guard let url = URL(string: "\(apiHost)/api/links") else { return .failure(.invalidURL) }
        var payload: [String: String] = [
            "url": targetUrl.trimmingCharacters(in: .whitespacesAndNewlines),
            "days": daysValue(ttlSeconds),
            "source": "ios"
        ]
        if let slug = cleaned(customSlug) { payload["slug"] = slug }
        if let password = cleaned(password) { payload["password"] = password }
        if let title = cleaned(title) { payload["title"] = title }
        if let description = cleaned(description) { payload["description"] = description }
        var request = authorizedRequest(url: url, method: "POST", token: token)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        return await finishCreate(request, host: apiHost, token: token)
    }

    /// Upload files as one share in a single multipart request.
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
        token: String = ""
    ) async -> Result<String, PortalError> {
        var ready = files.filter { !$0.content.isEmpty }
        if let preview, !preview.content.isEmpty { ready.append(preview) }
        guard !ready.isEmpty else { return .failure(.encodingFailed) }
        let apiHost = normalizedHost(host.isEmpty ? "https://\(domain)" : host)
        guard let url = URL(string: "\(apiHost)/api/shares") else { return .failure(.invalidURL) }

        let boundary = "Boundary-\(UUID().uuidString)"
        var request = authorizedRequest(url: url, method: "POST", token: token)
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        func addField(_ name: String, _ value: String) {
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".utf8))
            body.append(Data(value.utf8))
            body.append(Data("\r\n".utf8))
        }
        func addFile(_ part: UploadPart) {
            let name = safeFileName(part.fileName)
            let mime = part.mimeType.isEmpty ? "application/octet-stream" : part.mimeType
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"files\"; filename=\"\(name)\"\r\n".utf8))
            body.append(Data("Content-Type: \(mime)\r\n\r\n".utf8))
            body.append(part.content)
            body.append(Data("\r\n".utf8))
        }
        for part in ready { addFile(part) }
        addField("days", daysValue(ttlSeconds))
        addField("source", "ios")
        if let slug = cleaned(customSlug) { addField("slug", slug) }
        if let password = cleaned(password) { addField("password", password) }
        if let title = cleaned(title) { addField("title", title) }
        if let description = cleaned(description) { addField("description", description) }
        body.append(Data("--\(boundary)--\r\n".utf8))
        request.httpBody = body
        return await finishCreate(request, host: apiHost, token: token)
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
        await createUpload(
            files: [UploadPart(fileName: fileName, content: content, mimeType: mimeType(for: fileName))],
            customSlug: customSlug,
            ttlSeconds: ttlSeconds,
            password: password,
            domain: domain,
            host: host,
            token: token
        )
    }

    private func finishCreate(_ request: URLRequest, host: String, token: String) async -> Result<String, PortalError> {
        guard !token.isEmpty else { return .failure(.unauthorized) }
        do {
            let (data, http) = try await send(request)
            if http.statusCode == 401 { return .failure(.unauthorized) }
            guard (200...299).contains(http.statusCode) else {
                return .failure(.serverError(serverMessage(from: data, fallback: "The link could not be created.")))
            }
            guard let envelope = try? JSONDecoder().decode(ApiShareEnvelope.self, from: data) else {
                return .failure(.serverError("FleetLink sent a response the app could not read."))
            }
            let created = Self.portalShare(envelope.share)
            shares.removeAll { $0.slug == created.slug }
            shares.insert(created, at: 0)
            computeAnalytics()
            return .success(created.url)
        } catch {
            return .failure(.serverError("The link could not be created.\u{00A0} Check the connection and try again."))
        }
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }

    private static func portalShare(_ share: ApiShare) -> PortalShare {
        PortalShare(
            slug: share.slug,
            url: share.url,
            mode: share.kind == "link" ? "redirect" : "files",
            files: share.kind == "link" ? 0 : share.file_count,
            bytes: share.total_bytes,
            password_protected: share.has_password,
            created_at: share.created_at,
            expires_at: share.expires_at ?? "never",
            renewals_used: share.renewals,
            team_id: share.team?.id,
            is_team: share.team != nil,
            is_mine: share.can_manage ?? true,
            target_url: share.target_url,
            title: share.title,
            description: share.description,
            can_manage: share.can_manage ?? true,
            can_edit: share.can_edit ?? true,
            team_name: share.team?.name,
            team_access: share.team?.access,
            owner_name: share.owner?.display_name
        )
    }

    private func computeAnalytics() {
        analytics = PortalAnalytics(
            totalShares: shares.count,
            totalFiles: shares.reduce(0) { $0 + $1.files },
            totalBytes: shares.reduce(Int64(0)) { $0 + $1.bytes },
            totalRedirects: shares.filter { $0.isRedirect }.count,
            totalFileShares: shares.filter { !$0.isRedirect }.count,
            expiringSoonCount: shares.filter { $0.isExpiringSoon }.count,
            passwordProtectedCount: shares.filter { $0.password_protected }.count
        )
    }

    /// Every account call carries the passkey session as a bearer token.
    private func authorizedRequest(url: URL, method: String, token: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("ios", forHTTPHeaderField: "X-Fleet-Client")
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            request.setValue("Bearer \(trimmed)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private static func pathSegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
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

    private func serverMessage(from data: Data, fallback: String) -> String {
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let message = json["error"] as? String, !message.isEmpty {
            return FleetLinkCopy.explain(message)
        }
        return FleetLinkCopy.explain(fallback)
    }
}
