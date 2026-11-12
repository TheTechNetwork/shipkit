import XCTest
@testable import ShipkitFixture

final class GreetingTests: XCTestCase {
    func testGreetingNamesWhoItGreets() {
        XCTAssertEqual(Greeting.text(for: "shipkit"), "Hello, shipkit")
    }
}
