// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NyxDesktop",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "NyxDesktop",
            path: "Sources/NyxDesktop"
        )
    ]
)
