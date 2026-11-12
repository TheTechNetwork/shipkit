// The smallest Kotlin DSL Android app: no dependencies, no code. It reads the
// android-release.yml env contract the way the shipkit README tells a non-Expo
// app (Fleetwright) to, so integration.yml can build it signed for real.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "shipkit-android-fixture"
include(":app")
