import SwiftUI
import UIKit

private final class HarnessProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let scope = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "scope" }?.value ?? "mine"
        let names = scope == "teams" ? ["team-view", "team-edit", "team-manage"] : scope == "bots" ? ["managed-bot"] : ["zeta", "alpha"]
        let rows: [[String: Any]] = names.enumerated().map { i, name in
            ["slug": name, "url": "https://fixture.invalid/\(name)", "kind": "files", "has_password": false, "file_count": 1, "total_bytes": i * 100 + 1, "renewals": 0, "created_at": "2026-11-0\(i + 1)T12:00:00Z", "can_manage": name == "team-manage" || scope == "mine", "can_edit": name != "team-view"]
        }
        let value: [String: Any] = request.url!.path == "/api/teams" ? ["teams": []] : ["shares": rows, "next": NSNull()]
        let data = try! JSONSerialization.data(withJSONObject: value)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
@main
struct HarnessApp: App {
    @StateObject private var session = SessionManager()
    @StateObject private var model: PortalManager
    init() {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [HarnessProtocol.self]
        _model = StateObject(wrappedValue: PortalManager(urlSession: URLSession(configuration: config)))
    }
    var body: some Scene {
        WindowGroup {
            if ProcessInfo.processInfo.arguments.contains("share-inputs") { ShareInputHarness() }
            else { PortalView(portalManager: model, tokenProvider: { "nonsecret-fixture-only" }, onSelectArtifact: { _ in }).environmentObject(session) }
        }
    }
}
private struct ShareInputHarness: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController { InputController() }
    func updateUIViewController(_ controller: UIViewController, context: Context) {}
}
private final class InputController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        let stack = UIStackView(); stack.axis = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false
        for kind in ["Text", "URL", "File", "Photo"] {
            let button = UIButton(type: .system); button.setTitle("Share \(kind)", for: .normal)
            button.addAction(UIAction { [weak self] _ in self?.share(kind) }, for: .touchUpInside); stack.addArrangedSubview(button)
        }
        view.addSubview(stack); NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: view.centerXAnchor), stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
    }
    private func share(_ kind: String) {
        let item: Any
        switch kind {
        case "URL": item = URL(string: "https://example.com/share-fixture")!
        case "File":
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("fixture.txt")
            try! Data("nonprivate file fixture".utf8).write(to: file); item = file
        case "Photo":
            item = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).image { context in UIColor.systemBlue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 64, height: 64)) }
        default: item = "nonprivate text fixture"
        }
        let sheet = UIActivityViewController(activityItems: [item], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        present(sheet, animated: true)
    }
}
