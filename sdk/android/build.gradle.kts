buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.1.0")
        // AGP 9 compiles Kotlin itself; it only needs the Kotlin Gradle plugin on the classpath.
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.0")
    }
}
