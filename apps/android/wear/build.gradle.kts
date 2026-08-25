import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.agentdeck.wear"
    compileSdk = 37
    compileSdkMinor = 1
    defaultConfig {
        applicationId = "dev.agentdeck"
        minSdk = 30
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
        val local = Properties().apply {
            rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use(::load)
        }
        buildConfigField("String", "BRIDGE_URL", "\"${local.getProperty("bridge.url", "http://10.0.2.2:3000")}\"")
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
}

dependencies {
    implementation(project(":shared"))
    implementation(platform("androidx.compose:compose-bom:2026.08.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    // Wear Compose, not the phone Material 3 this module used to render with.
    // The watch conventions - the clock overlay, edge-aware lists, the
    // swipe-back gesture, the rotating crown - live here and nowhere else.
    implementation("androidx.wear.compose:compose-material3:1.6.2")
    implementation("androidx.wear.compose:compose-foundation:1.6.2")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.core:core-ktx:1.19.0")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("com.google.android.gms:play-services-wearable:19.0.0")
    // Tiles are ProtoLayout, not Compose: the watch renders them in the system
    // process, so the layout has to be sent as data rather than composed here.
    implementation("androidx.wear.tiles:tiles:1.6.2")
    implementation("androidx.wear.protolayout:protolayout:1.4.2")
    implementation("androidx.wear.protolayout:protolayout-material3:1.4.2")
    implementation("androidx.wear.protolayout:protolayout-expression:1.4.2")
    implementation("com.google.guava:guava:33.5.0-android")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.10.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation(kotlin("test"))
    testImplementation("junit:junit:4.13.2")
}
