import Foundation
import Sentry

/// Starts sentry-cocoa when `SentryDSN` is present in Info.plist.
///
/// The DSN is injected at build time from the `SENTRY_DSN` environment /
/// build setting.  An empty or unsubstituted value leaves the SDK off, so
/// local and unsigned CI builds stay silent.  No default DSN is compiled in.
enum SentryTelemetry {
    static func start(surface: String) {
        guard let dsn = resolvedDSN() else { return }

        SentrySDK.start { options in
            options.dsn = dsn
            options.sendDefaultPii = false
            options.enableLogs = true
            options.tracesSampleRate = 0.2
            options.releaseName = releaseName
            options.environment = environmentName
            options.beforeSend = { event in
                event.user = nil
                return event
            }
        }

        SentrySDK.configureScope { scope in
            scope.setTag(value: surface, key: "surface")
            scope.setTag(value: "fleetlink", key: "app")
        }
    }

    private static func resolvedDSN() -> String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "SentryDSN") as? String else {
            return nil
        }
        let dsn = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if dsn.isEmpty || dsn.contains("$(") { return nil }
        return dsn
    }

    private static var releaseName: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return "\(version)+\(build)"
    }

    private static var environmentName: String {
        #if DEBUG
        return "development"
        #else
        return "production"
        #endif
    }
}
