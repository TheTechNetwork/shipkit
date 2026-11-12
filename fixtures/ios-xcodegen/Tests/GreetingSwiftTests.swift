import Testing
@testable import ShipkitFixture

// Swift Testing, the default for a new Xcode test target: the action has to
// count these as well as XCTest's.
@Test func greetingIsNotEmptyForAnEmptyName() {
    #expect(Greeting.text(for: "") == "Hello, ")
}
