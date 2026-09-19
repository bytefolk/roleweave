import SwiftUI

@main
struct RoleWeaveApp: App {
    @StateObject private var session = PhoneSession()

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environmentObject(session)
        }
    }
}

struct RootTabView: View {
    var body: some View {
        TabView {
            OrgView()
                .tabItem { Label("组织", systemImage: "person.3") }
            CommandView()
                .tabItem { Label("指令", systemImage: "paperplane") }
            SettingsView()
                .tabItem { Label("设置", systemImage: "gearshape") }
        }
    }
}
