import AppKit
import ImageIO
import MARVINLogic
import UniformTypeIdentifiers
import Vision

/// ADR-0129 — an image chip in the Supervisor tab, made ready for
/// `POST /api/supervisor/message`: scaled to the long edge the model uses,
/// re-encoded as PNG (or JPEG past the cap), and its text recognised on the
/// device so the route can refuse a screenshot of a secret. The recognised
/// text is sent for that check only; the route never stores it.
enum SupervisorImageUpload {
    struct Prepared: Sendable {
        let mediaType: String
        let base64: String
        let recognisedText: String
    }

    enum Failure: Error, Equatable {
        case unreadable(String)
        case tooLarge(String)
    }

    /// Off the main actor: decoding, scaling and text recognition take a beat on a big screenshot.
    static func prepare(paths: [String]) async -> Result<[Prepared], Failure> {
        await Task.detached(priority: .userInitiated) {
            var out: [Prepared] = []
            for path in paths {
                switch prepare(path: path) {
                case .success(let p): out.append(p)
                case .failure(let f): return .failure(f)
                }
            }
            return .success(out)
        }.value
    }

    static func prepare(path: String) -> Result<Prepared, Failure> {
        let name = (path as NSString).lastPathComponent
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int
        else { return .failure(.unreadable(name)) }
        let target = SupervisorComposer.targetSize(width: w, height: h)
        // The thumbnail API scales and applies the EXIF orientation in one pass.
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(target.width, target.height),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return .failure(.unreadable(name)) }
        guard let png = encode(image, as: .png) else { return .failure(.unreadable(name)) }
        var chosen: (String, Data)?
        for enc in SupervisorComposer.encodings(pngBytes: png.count) {
            if case .png = enc { chosen = ("image/png", png); break }
            if let jpg = encode(image, as: enc), jpg.count <= SupervisorComposer.maxImageBytes { chosen = ("image/jpeg", jpg); break }
        }
        guard let (type, data) = chosen else { return .failure(.tooLarge(name)) }
        return .success(Prepared(mediaType: type, base64: data.base64EncodedString(), recognisedText: recognisedText(image)))
    }

    private static func encode(_ image: CGImage, as enc: SupervisorComposer.Encoding) -> Data? {
        let data = NSMutableData()
        let type: UTType = { if case .png = enc { return .png } else { return .jpeg } }()
        guard let dest = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else { return nil }
        var props: [CFString: Any] = [:]
        if case .jpeg(let q) = enc { props[kCGImageDestinationLossyCompressionQuality] = q }
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        return CGImageDestinationFinalize(dest) ? data as Data : nil
    }

    /// On-device text recognition, for the route's secret check. Empty when Vision finds nothing or fails.
    private static func recognisedText(_ image: CGImage) -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
        } catch {
            return ""
        }
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}
