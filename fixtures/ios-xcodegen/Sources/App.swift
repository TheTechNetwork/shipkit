import SwiftUI

@main
struct ShipkitFixtureApp: App {
    var body: some Scene {
        WindowGroup { Text(Greeting.text(for: "shipkit")) }
    }
}

enum Greeting {
    static func text(for name: String) -> String { "Hello, \(name)" }
}
