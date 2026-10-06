import SwiftUI

public struct PortalView: View {
    @ObservedObject var portalManager: PortalManager
    var onSelectArtifact: (URL) -> Void

    @AppStorage("fleetlink_auth_token") private var authToken: String = ""
    @AppStorage("fleetlink_server_host") private var serverHost: String = "https://fleetlink.online"

    @State private var searchText: String = ""
    @State private var filterMode: ShareFilter = .all
    @State private var shareToDelete: PortalShare? = nil
    @State private var showDeleteConfirmation: Bool = false
    @State private var isRenewing: [String: Bool] = [:]
    @State private var copiedSlug: String? = nil

    enum ShareFilter: String, CaseIterable, Identifiable {
        case all = "All"
        case redirects = "Redirects"
        case files = "Files"
        case expiring = "Expiring Soon"

        var id: String { rawValue }
    }

    public init(portalManager: PortalManager, onSelectArtifact: @escaping (URL) -> Void) {
        self.portalManager = portalManager
        self.onSelectArtifact = onSelectArtifact
    }

    var filteredShares: [PortalShare] {
        portalManager.shares.filter { share in
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
            }
        }
    }

    public var body: some View {
        NavigationStack {
            List {
                // Analytics Dashboard Section
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Fleet Analytics")
                            .font(.caption.bold())
                            .foregroundColor(.secondary)
                            .textCase(.uppercase)

                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                            StatCard(
                                title: "Active Shares",
                                value: "\(portalManager.analytics.totalShares)",
                                systemImage: "link.circle.fill",
                                color: .blue
                            )

                            StatCard(
                                title: "Total Storage",
                                value: portalManager.analytics.formattedTotalBytes,
                                systemImage: "internaldrive.fill",
                                color: .purple
                            )

                            StatCard(
                                title: "Redirects",
                                value: "\(portalManager.analytics.totalRedirects)",
                                systemImage: "arrow.triangle.turn.up.right.circle.fill",
                                color: .green
                            )

                            StatCard(
                                title: "File Shares",
                                value: "\(portalManager.analytics.totalFileShares)",
                                systemImage: "doc.fill",
                                color: .orange
                            )
                        }

                        if portalManager.analytics.expiringSoonCount > 0 {
                            HStack {
                                Image(systemName: "exclamationmark.clock.fill")
                                    .foregroundColor(.yellow)
                                Text("\(portalManager.analytics.expiringSoonCount) share(s) expiring within 24 hours")
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
                                        .padding(.vertical, 6)
                                        .background(filterMode == filter ? Color.accentColor : Color(UIColor.secondarySystemFill))
                                        .foregroundColor(filterMode == filter ? .white : .primary)
                                        .cornerRadius(16)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }

                // Slugs List
                Section {
                    if portalManager.isLoading && portalManager.shares.isEmpty {
                        HStack {
                            Spacer()
                            ProgressView("Loading active shares...")
                            Spacer()
                        }
                        .padding()
                    } else if filteredShares.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "tray")
                                .font(.largeTitle)
                                .foregroundColor(.secondary)
                            Text("No shares found")
                                .font(.headline)
                            Text(searchText.isEmpty ? "No active shares registered." : "Try a different search query.")
                                .font(.caption)
                                .foregroundColor(.secondary)
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
                        Text("Active Shares (\(filteredShares.count))")
                        Spacer()
                        if portalManager.isLoading {
                            ProgressView()
                                .scaleEffect(0.8)
                        }
                    }
                }
            }
            .searchable(text: $searchText, prompt: "Search by slug or target URL")
            .refreshable {
                await portalManager.fetchShares(host: serverHost, token: authToken)
            }
            .navigationTitle("Portal & Analytics")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        Task {
                            await portalManager.fetchShares(host: serverHost, token: authToken)
                        }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .confirmationDialog(
                "Delete Share",
                isPresented: $showDeleteConfirmation,
                titleVisibility: .visible,
                presenting: shareToDelete
            ) { share in
                Button("Delete '\(share.slug)'", role: .destructive) {
                    Task {
                        _ = await portalManager.deleteShare(slug: share.slug, host: serverHost, token: authToken)
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: { share in
                Text("Are you sure you want to delete '\(share.slug)'? This will permanently remove the files from R2 storage.")
            }
            .task {
                if portalManager.shares.isEmpty {
                    await portalManager.fetchShares(host: serverHost, token: authToken)
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

    private func renewShare(_ share: PortalShare) {
        isRenewing[share.slug] = true
        Task {
            _ = await portalManager.renewShare(slug: share.slug, host: serverHost, token: authToken)
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
                .foregroundColor(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(title)
                .font(.caption2)
                .foregroundColor(.secondary)
        }
        .padding(10)
        .background(Color(UIColor.secondarySystemGroupedBackground))
        .cornerRadius(12)
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
                            Text("Redirect")
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
                                .font(.caption2)
                                .foregroundColor(.orange)
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
                    .foregroundColor(share.isExpiringSoon ? .yellow : .secondary)

                    if let renewals = share.renewals_used, renewals > 0 {
                        Text("\(renewals) renewal\(renewals == 1 ? "" : "s")")
                            .font(.system(size: 9))
                            .foregroundColor(.secondary)
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
            }
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }
}
