# RoleWeave iOS

Native SwiftUI client. Open `RoleWeave.xcodeproj` in Xcode 15+ on a Mac.

1. Select an iPhone simulator or device.
2. Set the host (persisted) in 指令 / 设置 to your RoleWeave URL.
3. For the desktop control plane, paste the boot-token; HTTP calls send `Authorization: Bearer <boot-token>` (`/health` is the only unauthenticated route).
4. Pair with a 6-digit code from the desktop. The socket reconnects with exponential backoff (1s/2s/4s/8s/16s, 5 attempts) and keeps the device token.
5. Select a role on 组织 before sending a command. Turns still run on the computer.

Requires iOS 17. Does not compile on Linux.
