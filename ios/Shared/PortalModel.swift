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
        if isRedirect { return "Redirect URL" }
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
        guard let exp = expiresDate else { return "Unknown" }
        let remaining = exp.timeIntervalSinceNow
        if remaining <= 0 { return "Expired" }
        let days = Int(remaining / 86400)
        let hours = Int((remaining.truncatingRemainder(dividingBy: 86400)) / 3600)
        if days > 0 {
            return "\(days)d \(hours)h"
        }
        let mins = Int((remaining.truncatingRemainder(dividingBy: 3600)) / 60)
        return "\(hours)h \(mins)m"
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

    public init() {}

    public func fetchShares(host: String = "https://fleetlink.online", token: String = "") async {
        isLoading = true
        errorMessage = nil

        let endpoint = "\(host)/api/shares"
        guard let url = URL(string: endpoint) else {
            errorMessage = "Invalid endpoint URL"
            isLoading = false
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            request.setValue("Bearer \(token.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                errorMessage = "Invalid server response"
                isLoading = false
                return
            }

            if httpResponse.statusCode == 401 {
                errorMessage = "Authentication required or token expired. Add your token in Settings."
                isLoading = false
                return
            }

            guard (200...299).contains(httpResponse.statusCode) else {
                let errText = String(data: data, encoding: .utf8) ?? "HTTP \(httpResponse.statusCode)"
                errorMessage = "Failed to load shares: \(errText)"
                isLoading = false
                return
            }

            let decoded = try JSONDecoder().decode(PortalSharesResponse.self, from: data)
            self.shares = decoded.shares
            computeAnalytics()
            isLoading = false
        } catch {
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }

    private func computeAnalytics() {
        let totalShares = shares.count
        let totalFiles = shares.reduce(0) { $0 + $1.files }
        let totalBytes = shares.reduce(Int64(0)) { $0 + $1.bytes }
        let totalRedirects = shares.filter { $0.isRedirect }.count
        let totalFileShares = shares.filter { !$0.isRedirect }.count
        let expiringSoonCount = shares.filter { $0.isExpiringSoon }.count
        let passwordProtectedCount = shares.filter { $0.password_protected }.count

        self.analytics = PortalAnalytics(
            totalShares: totalShares,
            totalFiles: totalFiles,
            totalBytes: totalBytes,
            totalRedirects: totalRedirects,
            totalFileShares: totalFileShares,
            expiringSoonCount: expiringSoonCount,
            passwordProtectedCount: passwordProtectedCount
        )
    }

    public func deleteShare(slug: String, host: String = "https://fleetlink.online", token: String = "") async -> Bool {
        guard let url = URL(string: "\(host)/api/shares/\(slug)") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        if !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            request.setValue("Bearer \(token.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse, (200...299).contains(httpResponse.statusCode) else {
                let errText = String(data: data, encoding: .utf8) ?? "Error"
                errorMessage = "Delete failed: \(errText)"
                return false
            }
            shares.removeAll { $0.slug == slug }
            computeAnalytics()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    public func renewShare(slug: String, host: String = "https://fleetlink.online", token: String = "") async -> Bool {
        guard let url = URL(string: "\(host)/api/shares/\(slug)/renew") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            request.setValue("Bearer \(token.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse, (200...299).contains(httpResponse.statusCode) else {
                let errText = String(data: data, encoding: .utf8) ?? "Error"
                errorMessage = "Renew failed: \(errText)"
                return false
            }
            await fetchShares(host: host, token: token)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

public enum PortalError: LocalizedError, Sendable {
    case invalidURL
    case unauthorized
    case serverError(String)
    case encodingFailed

    public var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .unauthorized: return "Unauthorized: Invalid or missing token"
        case .serverError(let msg): return msg
        case .encodingFailed: return "Encoding failed"
        }
    }
}

    public func createRedirect(
        targetUrl: String,
        customSlug: String? = nil,
        ttlSeconds: Int = 15552000,
        password: String? = nil,
        domain: String = "fleetlink.online",
        host: String = "https://fleetlink.online",
        token: String = ""
    ) async -> Result<String, PortalError> {
        guard let url = URL(string: "\(host)/api/shares") else {
            return .failure(.invalidURL)
        }

        let boundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            request.setValue("Bearer \(token.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
        }

        var body = Data()
        func addField(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }

        addField("mode", "redirect")
        addField("target_url", targetUrl)
        addField("ttl_seconds", "\(ttlSeconds)")
        addField("domain", domain)
        if let s = customSlug, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            addField("slug", s.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        if let p = password, !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            addField("password", p)
        }
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return .failure(.serverError("No response from server"))
            }
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let createdUrl = json["url"] as? String {
                    await fetchShares(host: host, token: token)
                    return .success(createdUrl)
                }
                if let err = json["error"] as? String {
                    return .failure(.serverError(err))
                }
            }
            if (200...299).contains(httpResponse.statusCode) {
                let text = String(data: data, encoding: .utf8) ?? ""
                return .success(text)
            }
            let errText = String(data: data, encoding: .utf8) ?? "HTTP \(httpResponse.statusCode)"
            return .failure(.serverError(errText))
        } catch {
            return .failure(.serverError(error.localizedDescription))
        }
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
        guard let url = URL(string: "\(host)/api/shares") else {
            return .failure(.invalidURL)
        }

        let boundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            request.setValue("Bearer \(token.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
        }

        var body = Data()
        func addField(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }

        addField("mode", "directory")
        addField("ttl_seconds", "\(ttlSeconds)")
        addField("domain", domain)
        // API only accepts custom slug for directory/file uploads with an auth token
        if let s = customSlug, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            addField("slug", s.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        if let p = password, !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            addField("password", p)
        }

        // Add file
        let cleanName = fileName.isEmpty ? "artifact.md" : fileName
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(cleanName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: application/octet-stream\r\n\r\n".data(using: .utf8)!)
        body.append(content)
        body.append("\r\n".data(using: .utf8)!)

        // Add relative path
        addField("path", cleanName)

        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return .failure(.serverError("No response from server"))
            }
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let createdUrl = json["url"] as? String {
                    await fetchShares(host: host, token: token)
                    return .success(createdUrl)
                }
                if let err = json["error"] as? String {
                    return .failure(.serverError(err))
                }
            }
            if (200...299).contains(httpResponse.statusCode) {
                let text = String(data: data, encoding: .utf8) ?? ""
                return .success(text)
            }
            let errText = String(data: data, encoding: .utf8) ?? "HTTP \(httpResponse.statusCode)"
            return .failure(.serverError(errText))
        } catch {
            return .failure(.serverError(error.localizedDescription))
        }
    }
}
