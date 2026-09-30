import SwiftUI

public struct DirectoryView: View {
    let items: [ArtifactItem]
    let onSelect: (ArtifactItem) -> Void
    let selectedItem: ArtifactItem?

    public init(items: [ArtifactItem], selectedItem: ArtifactItem?, onSelect: @escaping (ArtifactItem) -> Void) {
        self.items = items
        self.selectedItem = selectedItem
        self.onSelect = onSelect
    }

    public var body: some View {
        List {
            Section(header: Text("Batch Files (\(items.count))").font(.caption.bold())) {
                ForEach(items) { item in
                    Button(action: {
                        onSelect(item)
                    }) {
                        HStack(spacing: 12) {
                            Image(systemName: item.kind.systemIcon)
                                .font(.title3)
                                .foregroundColor(colorForKind(item.kind))
                                .frame(width: 28)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.name)
                                    .font(.body)
                                    .foregroundColor(.primary)
                                    .lineLimit(1)

                                HStack(spacing: 8) {
                                    Text(item.kind.displayName)
                                        .font(.caption2)
                                        .foregroundColor(.secondary)

                                    if let size = item.formattedSize {
                                        Text("•")
                                            .font(.caption2)
                                            .foregroundColor(.secondary)
                                        Text(size)
                                            .font(.caption2)
                                            .foregroundColor(.secondary)
                                    }
                                }
                            }

                            Spacer()

                            if selectedItem?.id == item.id {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(.accentColor)
                            } else {
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundColor(Color(UIColor.tertiaryLabel))
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func colorForKind(_ kind: ArtifactKind) -> Color {
        switch kind {
        case .markdown: return .blue
        case .image: return .purple
        case .html: return .orange
        case .code: return .green
        case .text: return .gray
        case .pdf: return .red
        case .directory: return .indigo
        case .binary: return .secondary
        }
    }
}
