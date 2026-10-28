plugins {
    id("com.android.library")
    id("maven-publish")
}

group = "dev.twig"
version = "0.1.0"

android {
    namespace = "dev.twig.links"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    implementation("com.android.installreferrer:installreferrer:2.2")
    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub in local unit tests; use the real implementation there.
    testImplementation("org.json:json:20180813")
}

publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = "dev.twig"
            artifactId = "twig-links"
            version = project.version.toString()
            afterEvaluate { from(components["release"]) }
        }
    }
}
