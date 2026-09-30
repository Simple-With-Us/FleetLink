import SwiftUI

public struct CodeView: View {
    let content: String
    let language: String?
    @State private var copied = false

    public init(content: String, language: String? = nil) {
        self.content = content
        self.language = language
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack {
                if let lang = language, !lang.isEmpty {
                    Text(lang.uppercased())
                        .font(.caption2.bold())
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color(UIColor.tertiarySystemFill))
                        .cornerRadius(6)
                }

                Spacer()

                Button(action: {
                    UIPasteboard.general.string = content
                    withAnimation { copied = true }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        withAnimation { copied = false }
                    }
                }) {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        Text(copied ? "Copied" : "Copy Code")
                    }
                    .font(.caption.bold())
                    .foregroundColor(copied ? .green : .accentColor)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Color(UIColor.tertiarySystemFill))
                    .cornerRadius(8)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(Color(UIColor.secondarySystemGroupedBackground))

            Divider()

            ScrollView([.horizontal, .vertical]) {
                Text(content)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color(UIColor.systemGroupedBackground))
        }
    }
}
