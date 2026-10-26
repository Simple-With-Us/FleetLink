import SwiftUI
import UniformTypeIdentifiers

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
    @State private var shareToRename: PortalShare? = nil
    @State private var renameSlugInput: String = ""
    @State private var showRenameAlert: Bool = false
    @State private var shareToExtend: PortalShare? = nil
    @State private var showExtendDialog: Bool = false
    @State private var shareToManage: PortalShare? = nil
    @State private var showManageSheet: Bool = false

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
                errorMessageBanner
                analyticsSection
                filterChipsSection
                sharesListSection
            }
            .searchable(text: $searchText, prompt: "Search by name or address")
            .refreshable {
                await portalManager.fetchShares(host: serverHost, token: session.apiToken)
            }
            .navigationTitle("Links")
            .toolbar {
                toolbarContent
            }
            .confirmationDialog(
                "Delete this link?",
                isPresented: $showDeleteConfirmation,
                titleVisibility: .visible,
                presenting: shareToDelete
            ) { share in
                Button("Delete '\(share.slug)'", role: .destructive) {
                    Task {
                        _ = await portalManager.deleteShare(slug: share.slug, host: serverHost, token: session.apiToken)
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: { share in
                Text("Delete \(share.slug)?\u{00A0} This cannot be undone.")
            }
            .alert("Rename Link", isPresented: $showRenameAlert) {
                renameAlertContent
            } message: {
                Text("Enter a new link name (slug).\u{00A0} Links using the old name will stop working.")
            }
            .confirmationDialog(
                "Extend Expiration",
                isPresented: $showExtendDialog,
                titleVisibility: .visible,
                presenting: shareToExtend
            ) { share in
                Button("Extend by 3 days") { extendShare(share, days: "3") }
                Button("Extend by 7 days") { extendShare(share, days: "7") }
                Button("Extend by 30 days") { extendShare(share, days: "30") }
                Button("Extend by 90 days") { extendShare(share, days: "90") }
                Button("Extend by 180 days") { extendShare(share, days: "180") }
                Button("Cancel", role: .cancel) {}
            } message: { share in
                Text("Extend \(share.slug) from today.\u{00A0} Choose a duration.")
            }
            .sheet(isPresented: $showManageSheet) {
                if let share = shareToManage {
                    ShareManageSheet(
                        share: share,
                        portalManager: portalManager,
                        serverHost: serverHost,
                        token: session.apiToken,
                        onDismiss: { showManageSheet = false }
                    )
                }
            }
            .task {
                if portalManager.shares.isEmpty {
                    await portalManager.fetchShares(host: serverHost, token: session.apiToken)
                }
                await portalManager.fetchTeams(host: serverHost, token: session.apiToken)
            }
            .onChange(of: session.user) { _, _ in
                Task { await portalManager.fetchShares(host: serverHost, token: session.apiToken) }
            }
        }
    }

    // MARK: - Subviews

    @ViewBuilder
    private var errorMessageBanner: some View {
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
    }

    @ViewBuilder
    private var analyticsSection: some View {
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
    }

    @ViewBuilder
    private var filterChipsSection: some View {
        Section {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(ShareFilter.allCases) { (filter: ShareFilter) in
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
    }

    @ViewBuilder
    private var sharesListSection: some View {
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
                ForEach(filteredShares) { (share: PortalShare) in
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
                        onRename: {
                            shareToRename = share
                            renameSlugInput = share.slug
                            showRenameAlert = true
                        },
                        onExtend: {
                            shareToExtend = share
                            showExtendDialog = true
                        },
                        onManageAccess: {
                            shareToManage = share
                            showManageSheet = true
                        },
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

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
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
                    await portalManager.fetchShares(host: serverHost, token: session.apiToken)
                }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .accessibilityLabel("Refresh links")
        }
    }

    @ViewBuilder
    private var renameAlertContent: some View {
        TextField("New name", text: $renameSlugInput)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled(true)
        Button("Rename") {
            if let share = shareToRename, !renameSlugInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let target = renameSlugInput.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                Task {
                    _ = await portalManager.renameShare(slug: share.slug, newSlug: target, host: serverHost, token: session.apiToken)
                }
            }
        }
        Button("Cancel", role: .cancel) {}
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
        return "Use New link to share a file or a web address.\u{00A0} Every link you make on any device shows up here."
    }

    private func renewShare(_ share: PortalShare) {
        isRenewing[share.slug] = true
        Task {
            _ = await portalManager.renewShare(slug: share.slug, host: serverHost, token: session.apiToken)
            isRenewing[share.slug] = false
        }
    }

    private func extendShare(_ share: PortalShare, days: String) {
        isRenewing[share.slug] = true
        Task {
            _ = await portalManager.extendShare(slug: share.slug, days: days, host: serverHost, token: session.apiToken)
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
    let onRename: () -> Void
    let onExtend: () -> Void
    let onManageAccess: () -> Void
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

                        if let teamName = share.team_name, !teamName.isEmpty {
                            Text(teamName + (share.team_access == "edit" ? " · edit" : " · view"))
                                .font(.caption2.bold())
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.purple.opacity(0.15))
                                .foregroundColor(.purple)
                                .cornerRadius(6)
                        } else if share.is_team == false || share.team_id == nil {
                            Text("Personal")
                                .font(.caption2.bold())
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.gray.opacity(0.15))
                                .foregroundColor(.secondary)
                                .cornerRadius(6)
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

                Menu {
                    Button(action: onRename) {
                        Label("Rename", systemImage: "pencil")
                    }
                    Button(action: onExtend) {
                        Label("Extend Expiry…", systemImage: "clock.arrow.circlepath")
                    }
                    Button(action: onManageAccess) {
                        Label("Share & Access…", systemImage: "person.2")
                    }
                    Button(action: onRenew) {
                        Label("Quick Renew (Default)", systemImage: "arrow.triangle.2.circlepath")
                    }
                    Divider()
                    Button(role: .destructive, action: onDelete) {
                        Label("Delete Early", systemImage: "trash")
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "ellipsis")
                        Text("More")
                    }
                    .font(.caption.bold())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color(UIColor.secondarySystemFill))
                    .cornerRadius(8)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("More options for \(share.slug)")

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
        .contextMenu {
            Button(action: onCopy) { Label("Copy Link", systemImage: "doc.on.doc") }
            Button(action: onView) { Label("View", systemImage: "arrow.up.right.square") }
            Divider()
            Button(action: onRename) { Label("Rename", systemImage: "pencil") }
            Button(action: onExtend) { Label("Extend Expiry…", systemImage: "clock.arrow.circlepath") }
            Button(action: onManageAccess) { Label("Share & Access…", systemImage: "person.2") }
            Divider()
            Button(role: .destructive, action: onDelete) { Label("Delete Early", systemImage: "trash") }
        }
    }
}

private struct ShareManageSheet: View {
    let share: PortalShare
    @ObservedObject var portalManager: PortalManager
    let serverHost: String
    let token: String
    let onDismiss: () -> Void

    @State private var title: String
    @State private var description: String
    @State private var destination: String
    @State private var isTeam: Bool
    @State private var selectedTeamId: String
    @State private var teamAccess: String
    @State private var passwordProtected: Bool
    @State private var passwordInput: String = ""
    @State private var isSaving: Bool = false
    @State private var errorMessage: String? = nil

    init(share: PortalShare, portalManager: PortalManager, serverHost: String, token: String, onDismiss: @escaping () -> Void) {
        self.share = share
        self.portalManager = portalManager
        self.serverHost = serverHost
        self.token = token
        self.onDismiss = onDismiss
        _title = State(initialValue: share.title ?? "")
        _description = State(initialValue: share.description ?? "")
        _destination = State(initialValue: share.target_url ?? "")
        _isTeam = State(initialValue: share.is_team ?? false)
        _selectedTeamId = State(initialValue: share.team_id ?? (portalManager.teams.first?.id ?? ""))
        _teamAccess = State(initialValue: share.team_access ?? "edit")
        _passwordProtected = State(initialValue: share.password_protected)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let error = errorMessage {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundColor(.red)
                    }
                }

                Section("Access & Sharing") {
                    Picker("Destination", selection: $isTeam) {
                        Text("Personal").tag(false)
                        Text("Team").tag(true)
                    }
                    .pickerStyle(.segmented)

                    if isTeam {
                        if portalManager.teams.isEmpty {
                            Text("No teams available.\u{00A0} Create or join a team on the web dashboard.")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        } else {
                            Picker("Team", selection: $selectedTeamId) {
                                ForEach(portalManager.teams) { team in
                                    Text(team.name).tag(team.id)
                                }
                            }
                            Picker("Team Permissions", selection: $teamAccess) {
                                Text("Can edit").tag("edit")
                                Text("View only").tag("view")
                            }
                        }
                    } else {
                        Text("Personal shares stay private to you and your fleet agents.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }

                Section("Protection") {
                    Toggle("Password Protected", isOn: $passwordProtected)
                    if passwordProtected {
                        SecureField(share.password_protected ? "New password (leave blank to keep)" : "Set a password", text: $passwordInput)
                    }
                }

                if share.isRedirect {
                    Section("Destination") {
                        TextField("https://example.com/page", text: $destination)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Text("Where this short link sends people.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }

                if share.isFilesShare {
                    ShareFilesSection(share: share, portalManager: portalManager, serverHost: serverHost, token: token)
                }

                Section("Details") {
                    TextField("Title", text: $title)
                    TextField("Description", text: $description)
                }

                Section {
                    Button(action: saveChanges) {
                        HStack {
                            Spacer()
                            if isSaving {
                                ProgressView()
                                    .padding(.trailing, 4)
                            }
                            Text("Save Changes")
                                .bold()
                            Spacer()
                        }
                    }
                    .disabled(isSaving)
                }
            }
            .navigationTitle("Manage \(share.slug)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", action: onDismiss)
                }
            }
        }
    }

    private func saveChanges() {
        isSaving = true
        errorMessage = nil
        Task {
            let teamId = isTeam ? selectedTeamId : nil
            let clearPassword = share.password_protected && !passwordProtected
            let newPassword = passwordProtected && !passwordInput.isEmpty ? passwordInput : nil
            let trimmedDestination = destination.trimmingCharacters(in: .whitespacesAndNewlines)
            let newDestination = share.isRedirect && !trimmedDestination.isEmpty && trimmedDestination != (share.target_url ?? "") ? trimmedDestination : nil
            let ok = await portalManager.updateShareAccess(
                slug: share.slug,
                teamId: teamId,
                teamAccess: teamAccess,
                password: newPassword,
                clearPassword: clearPassword,
                title: title.isEmpty ? nil : title,
                description: description.isEmpty ? nil : description,
                url: newDestination,
                host: serverHost,
                token: token
            )
            isSaving = false
            if ok {
                onDismiss()
            } else {
                errorMessage = portalManager.errorMessage ?? "Could not update settings.\u{00A0} Try again."
            }
        }
    }
}

/// Files in an existing file share:  list, remove, and add via the share-files API.
private struct ShareFilesSection: View {
    let share: PortalShare
    @ObservedObject var portalManager: PortalManager
    let serverHost: String
    let token: String

    @State private var shareFiles: [PortalShareFile] = []
    @State private var loadFailed: Bool = false
    @State private var isLoading: Bool = true
    @State private var showFilePicker: Bool = false
    @State private var busyPaths: Set<String> = []
    @State private var isAdding = false
    @State private var errorText: String? = nil

    var body: some View {
        Section("Files") {
            if let error = errorText {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundColor(.red)
            }
            if isLoading {
                HStack {
                    ProgressView()
                    Text("Loading files\u{2026}")
                        .foregroundColor(.secondary)
                }
            } else if loadFailed {
                Label("Could not load the file list.\u{00A0} Close and reopen to try again.", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundColor(.red)
            } else if shareFiles.isEmpty {
                Text("No files in this share yet.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                ForEach(shareFiles) { file in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(file.fileName)
                                .font(.subheadline)
                                .lineLimit(1)
                            Text(file.formattedSize)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                        if busyPaths.contains(file.path) {
                            ProgressView()
                        } else {
                            Button(role: .destructive) {
                                removeFile(file)
                            } label: {
                                Image(systemName: "trash")
                                    .font(.caption)
                                    .foregroundColor(.red)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove \(file.fileName)")
                            .disabled(isAdding || isLoading)
                        }
                    }
                }
            }
            Button {
                showFilePicker = true
            } label: {
                HStack {
                    if isAdding { ProgressView() }
                    Label(isAdding ? "Adding file..." : "Add File", systemImage: "plus")
                }
            }
            .disabled(isAdding || !busyPaths.isEmpty || isLoading)
        }
        .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.data], allowsMultipleSelection: false) { result in
            if case .success(let urls) = result, let picked = urls.first {
                addFile(picked)
            }
        }
        .task {
            #if FLEETLINK_VISUAL_FIXTURE
            let state = ProcessInfo.processInfo.environment["FLEETLINK_FIXTURE"] ?? "files"
            shareFiles = [
                PortalShareFile(path: "quarterly-report-with-a-long-file-name.pdf", size: 2_300_000, content_type: "application/pdf", url: nil),
                PortalShareFile(path: "notes/summary.md", size: 1234, content_type: "text/markdown", url: nil)
            ]
            isAdding = state == "uploading"
            loadFailed = state == "error"
            isLoading = false
            #else
            if let files = await portalManager.fetchShareFiles(slug: share.slug, host: serverHost, token: token) {
                shareFiles = files
                loadFailed = false
            } else {
                loadFailed = true
            }
            isLoading = false
            #endif
        }
    }

    private func removeFile(_ file: PortalShareFile) {
        guard !isAdding && !isLoading else { return }
        busyPaths.insert(file.path)
        errorText = nil
        Task {
            let ok = await portalManager.removeShareFile(slug: share.slug, path: file.path, host: serverHost, token: token)
            busyPaths.remove(file.path)
            if ok {
                shareFiles.removeAll { $0.path == file.path }
            } else {
                errorText = portalManager.errorMessage ?? "Could not remove the file.\u{00A0} Try again."
            }
        }
    }

    private func addFile(_ url: URL) {
        guard !isLoading && !isAdding && busyPaths.isEmpty else {
            errorText = "Wait for the current file operation to finish, then choose the file again."
            return
        }
        isAdding = true
        errorText = nil
        Task {
            let ok = await portalManager.addShareFile(slug: share.slug, fileURL: url, host: serverHost, token: token)
            defer { isAdding = false }
            if ok, let files = await portalManager.fetchShareFiles(slug: share.slug, host: serverHost, token: token) {
                shareFiles = files
                loadFailed = false
                errorText = nil
            } else if ok {
                loadFailed = true
                errorText = "File added, but the refreshed list could not be loaded. Close and reopen to try again."
            } else if !ok {
                errorText = portalManager.errorMessage ?? "Could not add the file.\u{00A0} Try again."
            }
        }
    }
}

#if FLEETLINK_VISUAL_FIXTURE
/// CI-only root: the actual management sheet with synthetic data, no account or network.
struct ShareManagementVisualFixture: View {
    @StateObject private var manager = PortalManager()
    private var isLink: Bool { ProcessInfo.processInfo.environment["FLEETLINK_FIXTURE"] == "redirect" }
    var body: some View {
        ShareManageSheet(
            share: PortalShare(slug: isLink ? "fixture-link" : "fixture-files", url: "https://example.invalid/fixture", mode: isLink ? "redirect" : "files", files: isLink ? 0 : 2, bytes: 2_301_234, password_protected: false, created_at: "2026-10-26T00:00:00Z", expires_at: "never", target_url: isLink ? "https://example.com/new-destination" : nil, title: "Visual fixture"),
            portalManager: manager, serverHost: "https://example.invalid", token: "", onDismiss: {}
        )
        .safeAreaInset(edge: .bottom) { Text("CI FIXTURE - NOT LIVE DATA").font(.caption).padding(4).frame(maxWidth: .infinity).background(Color.yellow) }
    }
}
#endif
