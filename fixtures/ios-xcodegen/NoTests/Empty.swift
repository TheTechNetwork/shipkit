import XCTest

// A bundle that builds and runs and executes nothing: `xcodebuild test` still
// exits 0, which is exactly what actions/ios-simulator-test must not accept.
final class Empty: XCTestCase {}
