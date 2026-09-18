# RoleWeave Android

Native Kotlin + Compose client. Open the `android/` folder in Android Studio (Koala or newer).

1. Sync Gradle.
2. Run on a device or emulator (API 26+).
3. In 指令, set the RoleWeave host, pair with the desktop code, send a command.

Release builds require HTTPS (`src/main` network security config). Debug builds allow HTTP (`src/debug`) so a local RoleWeave (`127.0.0.1`) can pair.

Commands require an explicit org-tab role tap. Load does not pick `roles.first()`.

CI: `.github/workflows/android-client.yml` runs `gradle test` (JDK 17 + Android SDK) on `mobile/android/**`.
