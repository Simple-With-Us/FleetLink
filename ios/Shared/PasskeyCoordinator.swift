import AuthenticationServices
import Foundation
import UIKit

/// Passkey registration and sign-in via AuthenticationServices.
/// The worker returns a bearer token.  This type never sets an Origin header.
@MainActor
public final class PasskeyCoordinator: NSObject, ObservableObject {
    @Published public private(set) var isPresenting = false

    private weak var owner: SessionManager?
    private var continuation: CheckedContinuation<ASAuthorization, Error>?

    public init(owner: SessionManager) {
        self.owner = owner
        super.init()
    }

    public func createPasskey(displayName: String, email: String) async {
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            owner?.report(error: "Enter A Display Name To Create A Passkey.")
            return
        }
        await run(errorPrefix: "Passkey Creation Failed.") { [self] in
            let started = try await post(
                path: "api/auth/passkey/register/options",
                body: ["displayName": name, "email": email.trimmingCharacters(in: .whitespacesAndNewlines)]
            )
            let challenge = try Base64URL.decode(started.options.challenge)
            let userID = try Base64URL.decode(started.options.user?.id ?? "")
            let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: started.options.relyingPartyId)
            let request = provider.createCredentialRegistrationRequest(
                challenge: challenge,
                name: started.options.user?.name ?? name,
                userID: userID
            )
            request.displayName = started.options.user?.displayName ?? name
            let authorization = try await perform(request)
            guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
                throw Failure.invalidResponse
            }
            let payload = RegistrationPayload(
                challengeId: started.challengeId,
                credential: .init(
                    id: credential.credentialID.base64URLEncodedString(),
                    rawId: credential.credentialID.base64URLEncodedString(),
                    type: "public-key",
                    response: .init(
                        clientDataJSON: credential.rawClientDataJSON.base64URLEncodedString(),
                        attestationObject: credential.rawAttestationObject?.base64URLEncodedString() ?? ""
                    )
                )
            )
            let session = try await postVerify(path: "api/auth/passkey/register/verify", payload: payload)
            owner?.adoptBearerToken(session.token)
            await owner?.refreshSession()
        }
    }

    public func signIn(email: String) async {
        await run(errorPrefix: "Passkey Sign-In Failed.") { [self] in
            var body: [String: String] = [:]
            let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { body["email"] = trimmed }
            let started = try await post(path: "api/auth/passkey/authenticate/options", body: body)
            let challenge = try Base64URL.decode(started.options.challenge)
            let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: started.options.relyingPartyId)
            let request = provider.createCredentialAssertionRequest(challenge: challenge)
            let authorization = try await perform(request)
            guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
                throw Failure.invalidResponse
            }
            let payload = AssertionPayload(
                challengeId: started.challengeId,
                credential: .init(
                    id: credential.credentialID.base64URLEncodedString(),
                    rawId: credential.credentialID.base64URLEncodedString(),
                    type: "public-key",
                    response: .init(
                        clientDataJSON: credential.rawClientDataJSON.base64URLEncodedString(),
                        authenticatorData: credential.rawAuthenticatorData.base64URLEncodedString(),
                        signature: credential.signature.base64URLEncodedString(),
                        userHandle: credential.userID.base64URLEncodedString()
                    )
                )
            )
            let session = try await postVerify(path: "api/auth/passkey/authenticate/verify", payload: payload)
            owner?.adoptBearerToken(session.token)
            await owner?.refreshSession()
        }
    }

    private func run(errorPrefix: String, _ body: () async throws -> Void) async {
        isPresenting = true
        defer { isPresenting = false }
        do {
            try await body()
            owner?.report(error: nil)
        } catch let error as Failure {
            owner?.report(error: error.message)
        } catch let error as ASAuthorizationError where error.code == .canceled {
            owner?.report(error: "Passkey Sign-In Was Cancelled.")
        } catch {
            owner?.report(error: "\(errorPrefix)  \(error.localizedDescription)")
        }
    }

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    private func endpoint(_ path: String) -> URL {
        SessionManager.accountOrigin.appending(path: path)
    }

    private func post(path: String, body: [String: String]) async throws -> Ceremony {
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("ios", forHTTPHeaderField: "X-Fleet-Client")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try Self.check(response, data: data)
        return try JSONDecoder().decode(Ceremony.self, from: data)
    }

    private func postVerify<T: Encodable>(path: String, payload: T) async throws -> TokenResponse {
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("ios", forHTTPHeaderField: "X-Fleet-Client")
        request.httpBody = try JSONEncoder().encode(payload)
        let (data, response) = try await URLSession.shared.data(for: request)
        try Self.check(response, data: data)
        return try JSONDecoder().decode(TokenResponse.self, from: data)
    }

    private static func check(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw Failure.network }
        guard (200...299).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            throw Failure.server(message ?? "The Account Service Rejected The Passkey.")
        }
    }

    private enum Failure: Error {
        case invalidResponse
        case network
        case server(String)
        var message: String {
            switch self {
            case .invalidResponse: return "The Passkey Response Was Not Valid."
            case .network: return "Could Not Reach The Account Service."
            case .server(let message): return message
            }
        }
    }
}

extension PasskeyCoordinator: ASAuthorizationControllerDelegate {
    public nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        Task { @MainActor in
            self.continuation?.resume(returning: authorization)
            self.continuation = nil
        }
    }

    public nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        Task { @MainActor in
            self.continuation?.resume(throwing: error)
            self.continuation = nil
        }
    }
}

extension PasskeyCoordinator: ASAuthorizationControllerPresentationContextProviding {
    public nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.flatMap(\.windows).first
        return window ?? ASPresentationAnchor()
    }
}

private struct Ceremony: Decodable {
    let challengeId: String
    let options: Options
    struct Options: Decodable {
        let challenge: String
        let rp: RelyingParty?
        let rpId: String?
        let user: User?
        var relyingPartyId: String { rp?.id ?? rpId ?? "fleetlink.app" }
        struct RelyingParty: Decodable { let id: String }
        struct User: Decodable { let id: String; let name: String; let displayName: String }
    }
}

private struct TokenResponse: Decodable { let token: String }

private struct ErrorBody: Decodable { let error: String }

private struct RegistrationPayload: Encodable {
    let challengeId: String
    let credential: Credential
    struct Credential: Encodable {
        let id: String
        let rawId: String
        let type: String
        let response: Response
    }
    struct Response: Encodable {
        let clientDataJSON: String
        let attestationObject: String
    }
}

private struct AssertionPayload: Encodable {
    let challengeId: String
    let credential: Credential
    struct Credential: Encodable {
        let id: String
        let rawId: String
        let type: String
        let response: Response
    }
    struct Response: Encodable {
        let clientDataJSON: String
        let authenticatorData: String
        let signature: String
        let userHandle: String
    }
}

private enum Base64URL {
    static func decode(_ value: String) throws -> Data {
        var text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let padding = (4 - (text.count % 4)) % 4
        text.append(String(repeating: "=", count: padding))
        guard let data = Data(base64Encoded: text) else { throw PasskeyCoordinatorError.decode }
        return data
    }
}

private enum PasskeyCoordinatorError: Error { case decode }

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
