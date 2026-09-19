# Native RoleWeave clients

Three separate apps. They do not share UI code.

| App | Stack | Open with | Issue |
| --- | --- | --- | --- |
| `ios/` | SwiftUI, iOS 17 | Xcode | #338 |
| `android/` | Kotlin, Jetpack Compose | Android Studio | #339 |
| `harmony/` | ArkTS, ArkUI API 12 | DevEco Studio | #340 |

Each app talks to a **running RoleWeave desktop / hosted entry**:

- `GET /api/mobile/workspace` — org preview
- `POST /phone-link/v1/pair` `{ "code": "123456" }` — pair
- `ws(s)://host/phone-link/phone` — send `command.submit`

Turns execute on the computer. These apps do not run Agents.

This Linux sandbox cannot compile iOS, Android, or HarmonyOS binaries. Open each project on the matching OS.
