import SwiftUI

public struct MarkdownView: View {
    let content: String

    public init(content: String) {
        self.content = content
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(LocalizedStringKey(content))
                    .font(.system(.body, design: .default))
                    .lineSpacing(6)
                    .textSelection(.enabled)
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(UIColor.secondarySystemGroupedBackground))
                    .cornerRadius(12)
            }
            .padding()
        }
    }
}
