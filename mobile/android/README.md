# RoleWeave Android

Native Kotlin + Compose client. Open the `android/` folder in Android Studio (Koala or newer).

1. Sync Gradle.
2. Run on a device or emulator (API 26+).
3. In 指令, set the RoleWeave host, pair with the desktop code, send a command.

Release builds require HTTPS. Debug builds allow HTTP so a local RoleWeave (`127.0.0.1`) can pair.

CI runs `gradle test` on `mobile/android` via `.github/workflows/android-client.yml`.
