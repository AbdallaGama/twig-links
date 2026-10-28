// swift-tools-version: 5.9
// Root manifest so the iOS SDK can be added straight from this repository's Git URL
// (Swift Package Manager requires Package.swift at the repository root).
import PackageDescription

let package = Package(
    name: "TwigLinks",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "TwigLinks", targets: ["TwigLinks"]),
    ],
    targets: [
        .target(
            name: "TwigLinks",
            path: "sdk/ios/TwigLinks/Sources/TwigLinks",
            resources: [.process("PrivacyInfo.xcprivacy")]
        ),
        .testTarget(name: "TwigLinksTests", dependencies: ["TwigLinks"], path: "sdk/ios/TwigLinks/Tests/TwigLinksTests"),
    ]
)
