import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun buildConfigString(value: String): String =
    "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

val debugWebClientUrl = providers.gradleProperty("yaWebClientUrl").orNull
    ?.trim()
    ?.takeIf(String::isNotEmpty)
val nativeProbeCleartext = providers.gradleProperty("yaNativeProbeCleartext").orNull
    ?.trim()
    ?.let {
        require(it == "true" || it == "false") {
            "yaNativeProbeCleartext must be true or false"
        }
        it.toBoolean()
    }
    ?: false

if (debugWebClientUrl != null) {
    val uri = URI(debugWebClientUrl)
    require(uri.scheme == "http" || uri.scheme == "https") {
        "yaWebClientUrl must use http or https"
    }
    require(uri.host != null && uri.userInfo == null) {
        "yaWebClientUrl must have a host and no user information"
    }
    require(uri.rawQuery == null && uri.rawFragment == null) {
        "yaWebClientUrl must not contain a query or fragment"
    }
}

val hasFirebaseConfiguration = file("google-services.json").isFile
if (hasFirebaseConfiguration) {
    apply(plugin = "com.google.gms.google-services")
} else {
    logger.lifecycle("google-services.json not found; Firebase messaging is disabled")
}

val pushBrokerUrl = providers.gradleProperty("yaPushBrokerUrl").orNull
    ?.trim()
    ?.takeIf(String::isNotEmpty)
    ?: "https://push.yepanywhere.com/"
run {
    val uri = URI(pushBrokerUrl)
    require(uri.scheme == "https") {
        "yaPushBrokerUrl must use https"
    }
    require(uri.host != null && uri.userInfo == null) {
        "yaPushBrokerUrl must have a host and no user information"
    }
    require(uri.rawQuery == null && uri.rawFragment == null) {
        "yaPushBrokerUrl must not contain a query or fragment"
    }
    require(uri.path.isNullOrEmpty() || uri.path == "/") {
        "yaPushBrokerUrl must not contain a path"
    }
}

android {
    namespace = "com.yepanywhere.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.yepanywhere.mobile"
        minSdk = 24
        targetSdk = 36
        versionCode = 1000
        versionName = "0.1.0"
        ndk {
            // Keep the app's established modern Android ABI set and prevent
            // JNA's AAR from reintroducing obsolete armeabi/MIPS binaries.
            abiFilters += setOf("arm64-v8a", "armeabi-v7a", "x86", "x86_64")
        }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        buildConfigField(
            "String",
            "DEBUG_WEB_CLIENT_URL",
            buildConfigString(debugWebClientUrl.orEmpty()),
        )
        buildConfigField(
            "String",
            "PUSH_BROKER_URL",
            buildConfigString(pushBrokerUrl),
        )
        buildConfigField(
            "boolean",
            "FIREBASE_CONFIGURED",
            hasFirebaseConfiguration.toString(),
        )
    }

    buildTypes {
        debug {
            isDebuggable = true
            manifestPlaceholders["usesCleartextTraffic"] =
                (
                    debugWebClientUrl?.startsWith("http://") == true ||
                        nativeProbeCleartext
                ).toString()
        }
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    flavorDimensions += "clientChannel"
    productFlavors {
        create("bundled") {
            dimension = "clientChannel"
            buildConfigField("boolean", "BUNDLED_CLIENT", "true")
            buildConfigField(
                "String",
                "WEB_CLIENT_URL",
                buildConfigString("https://appassets.androidplatform.net/"),
            )
        }
        create("hostedLatest") {
            dimension = "clientChannel"
            buildConfigField("boolean", "BUNDLED_CLIENT", "false")
            buildConfigField(
                "String",
                "WEB_CLIENT_URL",
                buildConfigString("https://latest.yepanywhere.com/"),
            )
        }
    }

    sourceSets {
        getByName("bundled") {
            assets.srcDir(layout.buildDirectory.dir("generated/webAssets"))
        }
        getByName("test") {
            resources.srcDir("src/sharedTest/resources")
            resources.srcDir("../../shared/test/fixtures")
        }
        getByName("androidTest") {
            assets.srcDir("src/sharedTest/resources")
            assets.srcDir("../../shared/test/fixtures")
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.15"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
        // JNA's Android AAR ships libjnidispatch prebuilt in a form the NDK
        // stripper does not recognize. Preserve it deliberately so builds do
        // not emit a misleading strip warning.
        jniLibs.keepDebugSymbols += "**/libjnidispatch.so"
    }
    lint {
        warningsAsErrors = true
        // Toolchain and library upgrades are reviewed changes. Network-based
        // freshness checks are not deterministic build-quality diagnostics.
        disable += setOf(
            "AndroidGradlePluginVersion",
            "GradleDependency",
            "NewerVersionAvailable",
        )
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.00")

    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.datastore:datastore-preferences:1.1.7")
    implementation("androidx.fragment:fragment-ktx:1.8.9")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.2")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.goterl:lazysodium-android:5.2.0") {
        // The AAR API is Java bytecode. Its POM's Kotlin 2.1 stdlib is used
        // only by transitive Android helpers and conflicts with this app's
        // Kotlin 1.9 compiler; the app already supplies a compatible stdlib.
        exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib")
        // Android needs JNA's AAR-packaged libjnidispatch rather than the
        // ordinary JVM JAR selected by LazySodium's published POM.
        exclude(group = "net.java.dev.jna", module = "jna")
    }
    implementation("net.java.dev.jna:jna:5.17.0@aar")
    implementation(platform("com.google.firebase:firebase-bom:34.16.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("com.nimbusds:srp6a:2.1.0")
    // OkHttp 5.x is compiled with Kotlin 2.2. Keep the latest 4.x release
    // until the Android Kotlin/Compose compiler is upgraded deliberately.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.test.espresso:espresso-intents:3.7.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}

val verifyBundledWebAssets = tasks.register("verifyBundledWebAssets") {
    val indexFile = layout.buildDirectory.file("generated/webAssets/index.html")
    inputs.file(indexFile)
    doLast {
        check(indexFile.get().asFile.isFile) {
            "Bundled web assets are missing; run `pnpm prepare-frontend` first"
        }
    }
}

tasks.matching {
    it.name.startsWith("mergeBundled") && it.name.endsWith("Assets")
}.configureEach {
    dependsOn(verifyBundledWebAssets)
}

tasks.matching {
    debugWebClientUrl != null &&
        it.name.startsWith("pre") &&
        it.name.endsWith("ReleaseBuild")
}.configureEach {
    doFirst {
        error("yaWebClientUrl is a debug-only override")
    }
}
