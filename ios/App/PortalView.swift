import SwiftUI

public struct PortalView: View {
    @ObservedObject var portalManager: PortalManager
    var onSelectArtifact: (URL) -> Void

    @EnvironmentObject private var session: SessionManager
    @AppStorage("fleetlink_server_host") private var serverHost: String = "https://fleetlink.online"

    @State private var searchText: String = ""
    @State private var filterMode: ShareFilter = .all
    @State private var shareToDelete: PortalShare? = nil
    @State private var showDeleteConfirmation: Bool = false
    @State private var isRenewing: [String: Bool] = [:]
    @State private var copiedSlug: String? = nil
    @State private var sortMode: ShareSort = .newest

    enum ShareFilter: String, CaseIterable, Identifiable {
        case all = "All"
        case redirects = "Short links"
        case files = "Files"
        case expiring = "Expiring soon"
        case locked = "Locked"

        var id: String { rawValue }
    }

    enum ShareSort: String, CaseIterable, Identifiable {
        case newest = "Newest"
        case expiring = "Expiring first"
        case name = "Name"
        case largest = "Largest"

        var id: String { rawValue }
    }

    public init(portalManager: PortalManager, onSelectArtifact: @escaping (URL) -> Void) {
        self.portalManager = portalManager
        self.onSelectArtifact = onSelectArtifact
    }

    var filteredShares: [PortalShare] {
        let rows = portalManager.shares.filter { share in
            let matchesSearch = searchText.isEmpty ||
                share.slug.localizedCaseInsensitiveContains(searchText) ||
                (share.target_url?.localizedCaseInsensitiveContains(searchText) ?? false)

            guard matchesSearch else { return false }

            switch filterMode {
            case .all:
                return true
            case .redirects:
                return share.isRedirect
            case .files:
                return !share.isRedirect
            case .expiring:
                return share.isExpiringSoon
            case .locked:
                return share.password_protected
            }
        }
        switch sortMode {
        case .newest:
            return rows.sorted { ($0.createdDate ?? .distantPast) > ($1.createdDate ?? .distantPast) }
        case .expiring:
            return rows.sorted { ($0.expiresDate ?? .distantFuture) < ($1.expiresDate ?? .distantFuture) }
        case .name:
            return rows.sorted { $0.slug.localizedCaseInsensitiveCompare($1.slug) == .orderedAscending }
        case .largest:
            return rows.sorted { $0.bytes > $1.bytes }
        }
    }

    public var body: some View {
        NavigationStack {
            List {
                if let message = portalManager.errorMessage, !message.isEmpty {
                    Section {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundColor(.orange)
                            Text(message)
                                .font(.subheadline)
                                .foregroundColor(.orange)
                        }
                    }
                }

                // Analytics Dashboard Section
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("At a glance")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                            .accessibilityAddTraits(.isHeader)

                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                            StatCard(
                                title: "Links",
                                value: "\(portalManager.analytics.totalShares)",
                                systemImage: "link.circle.fill",
                                color: .blue
                            )

                            StatCard(
                                title: "Storage",
                                value: portalManager.analytics.formattedTotalBytes,
                                systemImage: "internaldrive.fill",
                                color: .purple
                            )

                            StatCard(
                                title: "Short links",
                                value: "\(portalManager.analytics.totalRedirects)",
                                systemImage: "arrow.triangle.turn.up.right.circle.fill",
                                color: .green
                            )

                            StatCard(
                                title: "Files",
                                value: "\(portalManager.analytics.totalFileShares)",
                                systemImage: "doc.fill",
                                color: .orange
                            )
                        }

                        if portalManager.analytics.expiringSoonCount > 0 {
                            HStack {
                                Image(systemName: "exclamationmark.clock.fill")
                                    .foregroundColor(.orange)
                                    .accessibilityHidden(true)
                                Text("\(portalManager.analytics.expiringSoonCount) \(portalManager.analytics.expiringSoonCount == 1 ? "link expires" : "links expire") within 24 hours")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                            .padding(.top, 4)
                        }
                    }
                    .padding(.vertical, 6)
                }

                // Filter Chips
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(ShareFilter.allCases) { filter in
                                Button {
                                    filterMode = filter
                                } label: {
                                    Text(filter.rawValue)
                                        .font(.subheadline.bold())
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 8)
                                        .background(filterMode == filter ? Color.accentColor : Color(UIColor.secondarySystemFill))
                                        .foregroundColor(filterMode == filter ? .white : .primary)
                                        .cornerRadius(16)
                                }
                                .buttonStyle(.plain)
                                .accessibilityAddTraits(filterMode == filter ? .isSelected : [])
                                .accessibilityLabel(filter.rawValue)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }

                // Slugs List
                if let error = portalManager.errorMessage {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .accessibilityLabel("Error.\u{00A0} \(error)")
                    }
                }

                Section {
                    if portalManager.isLoading && portalManager.shares.isEmpty {
                        HStack {
                            Spacer()
                            ProgressView("Loading your links…")
                            Spacer()
                        }
                        .padding()
                    } else if filteredShares.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "tray")
                                .font(.largeTitle)
                                .foregroundColor(.secondary)
                            Text(emptyTitle)
                                .font(.headline)
                            Text(emptyDetail)
                                .font(.body)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                    } else {
                        ForEach(filteredShares) { share in
                            ShareRowView(
                                share: share,
                                copiedSlug: copiedSlug,
                                isRenewing: isRenewing[share.slug] ?? false,
                                onCopy: { copyShareLink(share) },
                                onView: {
                                    if let url = URL(string: share.url) {
                                        onSelectArtifact(url)
                                    }
                                },
                                onRenew: { renewShare(share) },
                                onDelete: {
                                    shareToDelete = share
                                    showDeleteConfirmation = true
                                }
                            )
                        }
                    }
                } header: {
                    HStack {
                        Text("Links (\(filteredShares.count))")
                        Spacer()
                        if portalManager.isLoading {
                            ProgressView()
                                .scaleEffect(0.8)
                        }
                    }
                }
            }
            .searchable(text: $searchText, prompt: "Search by name or address")
            .refreshable {
                await portalManager.fetchShares(host: serverHost, token: session.bearerSecret, sessionCookie: session.sessionCookieHeader)
            }
            .navigationTitle("Links")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        Picker("Sort", selection: $sortMode) {
                            ForEach(ShareSort.allCases) { mode in
                                Text(mode.rawValue).tag(mode)
                            }
                        }
                    } label: {
                        Image(systemName: "arrow.up.arrow.down")
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        Task {
                            await portalManager.fetchShares(host: serverHost, token: session.bearerSecret, sessionCookie: session.sessionCookieHeader)
                        }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh links")
                }
            }
            .confirmationDialog(
                "Delete this link?",
                isPresented: $showDeleteConfirmation,
                titleVisibility: .visible,
                presenting: shareToDelete
            ) { share in
                Button("Delete '\(share.slug)'", role: .destructive) {
                    Task {
                        _ = await portalManager.deleteShare(slug: share.slug, host: serverHost, token: session.bearerSecret, sessionCookie: session.sessionCookieHeader)
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: { share in
                Text("Delete \(share.slug)?  This cannot be undone.")
            }
            .task {
                if portalManager.shares.isEmpty {
                    await portalManager.fetchShares(host: serverHost, token: session.bearerSecret, sessionCookie: session.sessionCookieHeader)
                }
            }
        }
    }

    private func copyShareLink(_ share: PortalShare) {
        UIPasteboard.general.string = share.url
        copiedSlug = share.slug
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if copiedSlug == share.slug {
                copiedSlug = nil
            }
        }
    }

    private var emptyTitle: String {
        if !searchText.isEmpty || filterMode != .all {
            return "Nothing matches"
        }
        return "No links yet"
    }

    private var emptyDetail: String {
        if !searchText.isEmpty || filterMode != .all {
            return "Try a different word, or show every link."
        }
        return "Use New link to share a file or a web address.\u{00A0} Links you make on the website show up here after you sign in."
    }

    private func renewShare(_ share: PortalShare) {
        isRenewing[share.slug] = true
        Task {
            _ = await portalManager.renewShare(slug: share.slug, host: serverHost, token: session.bearerSecret, sessionCookie: session.sessionCookieHeader)
            isRenewing[share.slug] = false
        }
    }
}

private struct StatCard: View {
    let title: String
    let value: String
    let systemImage: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: systemImage)
                    .foregroundColor(color)
                    .font(.subheadline)
                Spacer()
            }
            Text(value)
                .font(.title2.bold())
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .background(Color(UIColor.secondarySystemGroupedBackground))
        .cornerRadius(12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(value)")
    }
}

private struct ShareRowView: View {
    let share: PortalShare
    let copiedSlug: String?
    let isRenewing: Bool
    let onCopy: () -> Void
    let onView: () -> Void
    let onRenew: () -> Void
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(share.slug)
                            .font(.headline)
                            .foregroundColor(.primary)

                        if share.isRedirect {
                            Text("Short link")
                                .font(.caption2.bold())
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.green.opacity(0.15))
                                .foregroundColor(.green)
                                .cornerRadius(6)
                        } else {
                            Text("\(share.files) file\(share.files == 1 ? "" : "s")")
                                .font(.caption2.bold())
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.blue.opacity(0.15))
                                .foregroundColor(.blue)
                                .cornerRadius(6)
                        }

                        if share.password_protected {
                            Image(systemName: "lock.fill")
                                .font(.caption)
                                .foregroundStyle(.orange)
                                .accessibilityLabel("Password protected")
                        }
                    }

                    if let target = share.target_url {
                        Text("↳ \(target)")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    } else {
                        Text(share.formattedBytes)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }

                Spacer()

                // Expiration badge
                VStack(alignment: .trailing, spacing: 2) {
                    HStack(spacing: 3) {
                        Image(systemName: "clock")
                            .font(.caption2)
                        Text(share.timeRemainingString)
                            .font(.caption2.bold())
                    }
                    .foregroundStyle(share.isExpiringSoon ? Color.orange : Color.secondary)
                    .accessibilityLabel(share.isExpiringSoon ? "Expires soon.\u{00A0} \(share.timeRemainingString)" : share.timeRemainingString)

                    if let renewals = share.renewals_used, renewals > 0 {
                        Text("\(renewals) renewal\(renewals == 1 ? "" : "s")")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            // Action Buttons
            HStack(spacing: 8) {
                Button(action: onCopy) {
                    HStack(spacing: 4) {
                        Image(systemName: copiedSlug == share.slug ? "checkmark" : "doc.on.doc")
                        Text(copiedSlug == share.slug ? "Copied" : "Copy")
                    }
                    .font(.caption.bold())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color(UIColor.secondarySystemFill))
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copiedSlug == share.slug ? "Copied link for \(share.slug)" : "Copy link for \(share.slug)")

                Button(action: onView) {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.up.right.square")
                        Text("View")
                    }
                    .font(.caption.bold())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color(UIColor.secondarySystemFill))
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("View \(share.slug)")

                Button(action: onRenew) {
                    HStack(spacing: 4) {
                        if isRenewing {
                            ProgressView()
                                .scaleEffect(0.6)
                        } else {
                            Image(systemName: "arrow.triangle.2.circlepath")
                        }
                        Text("Renew")
                    }
                    .font(.caption.bold())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color(UIColor.secondarySystemFill))
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
                .disabled(isRenewing)
                .accessibilityLabel("Renew \(share.slug)")

                Spacer()

                Button(action: onDelete) {
                    Image(systemName: "trash")
                        .font(.caption)
                        .foregroundColor(.red)
                        .padding(6)
                        .background(Color.red.opacity(0.1))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Delete \(share.slug)")
            }
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }
}
