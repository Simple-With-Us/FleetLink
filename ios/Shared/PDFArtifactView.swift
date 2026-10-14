import PDFKit
import SwiftUI

public struct PDFArtifactView: UIViewRepresentable {
    let data: Data

    public init(data: Data) {
        self.data = data
    }

    public func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.document = PDFDocument(data: data)
        view.backgroundColor = .systemBackground
        return view
    }

    public func updateUIView(_ uiView: PDFView, context: Context) {
        guard uiView.document?.dataRepresentation() != data else { return }
        uiView.document = PDFDocument(data: data)
    }
}
