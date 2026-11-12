plugins {
    id("com.android.application")
}

android {
    namespace = "network.thetech.shipkit.fixture"
    compileSdk = 36

    defaultConfig {
        applicationId = "network.thetech.shipkit.fixture"
        minSdk = 24
        targetSdk = 36
        // The README's "Android env contract", as written there.
        versionCode = providers.environmentVariable("ANDROID_VERSION_CODE").orNull?.toInt() ?: 1
        versionName = "1.0"
    }

    val keystore = providers.environmentVariable("ANDROID_KEYSTORE_FILE").orNull
    if (!keystore.isNullOrBlank()) signingConfigs.create("release") {
        storeFile = file(keystore)
        storePassword = providers.environmentVariable("ANDROID_KEYSTORE_PASSWORD").orNull
        keyAlias = providers.environmentVariable("ANDROID_KEY_ALIAS").orNull
        keyPassword = providers.environmentVariable("ANDROID_KEY_PASSWORD").orNull
    }
}
