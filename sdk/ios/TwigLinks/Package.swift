// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TwigLinks",
    platforms: [
        .iOS(.v15),
        .macOS(.v12), // lets `swift test` run the core logic on a Mac
    ],
    products: [
        .library(name: "TwigLinks", targets: ["TwigLinks"]),
    ],
    targets: [
        .target(
            name: "TwigLinks",
            resources: [.process("PrivacyInfo.xcprivacy")]
        ),
        .testTarget(name: "TwigLinksTests", dependencies: ["TwigLinks"]),
    ]
)
