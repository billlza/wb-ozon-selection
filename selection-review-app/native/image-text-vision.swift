import Foundation
import Vision

// The adapter supplies validated image bytes on stdin, never a user-controlled path.
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["ru-RU", "en-US"]
do {
    let languages = try request.supportedRecognitionLanguages()
    guard languages.contains("ru-RU") else {
        fputs("IMAGE_TEXT_LANGUAGE_UNAVAILABLE\n", stderr); exit(3)
    }
    if CommandLine.arguments == [CommandLine.arguments[0], "--capabilities"] {
        let payload: [String: Any] = ["version": "apple-vision-text-v1", "revision": request.revision, "languages": languages]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: payload))
        exit(0)
    }
    guard CommandLine.arguments.count == 1 else { fputs("IMAGE_TEXT_ARGUMENT_INVALID\n", stderr); exit(2) }
    let bytes = FileHandle.standardInput.readDataToEndOfFile()
    guard !bytes.isEmpty && bytes.count <= 20 * 1024 * 1024 else { fputs("IMAGE_TEXT_BYTES_INVALID\n", stderr); exit(2) }
    try VNImageRequestHandler(data: bytes).perform([request])
    guard let observations = request.results else { fputs("IMAGE_TEXT_RESULT_MISSING\n", stderr); exit(1) }
    let lines = observations.sorted {
        if $0.boundingBox.midY != $1.boundingBox.midY { return $0.boundingBox.midY > $1.boundingBox.midY }
        return $0.boundingBox.minX < $1.boundingBox.minX
    }.compactMap { $0.topCandidates(1).first?.string }
    let payload: [String: Any] = ["version": "apple-vision-text-v1", "revision": request.revision,
        "languages": ["ru-RU", "en-US"], "lines": lines]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: payload))
} catch {
    // Only a classified code crosses the process boundary, never raw file or account details.
    let failure = error as NSError
    fputs("IMAGE_TEXT_RECOGNITION_FAILED:\(failure.domain):\(failure.code)\n", stderr); exit(1)
}
