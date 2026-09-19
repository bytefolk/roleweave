import SwiftUI

struct OrgView: View {
    @EnvironmentObject private var session: PhoneSession
    @State private var detail: Role?

    var body: some View {
        NavigationStack {
            List {
                if let error = session.errorMessage {
                    Text(error).foregroundStyle(.red)
                }
                if let snapshot = session.snapshot {
                    Section(snapshot.description) {
                        ForEach(snapshot.roles) { role in
                            Button {
                                session.selectRole(role)
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(role.name).font(.headline)
                                        Text(role.description).font(.subheadline).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if session.selectedRoleId == role.id {
                                        Image(systemName: "checkmark.circle.fill")
                                    }
                                }
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button("详情") { detail = role }
                            }
                            .contextMenu {
                                Button("查看详情") { detail = role }
                                Button("选为发指令岗位") { session.selectRole(role) }
                            }
                        }
                    }
                }
            }
            .navigationTitle(session.snapshot?.name ?? "组织")
            .task { await session.loadOrg() }
            .refreshable { await session.loadOrg() }
            .sheet(item: $detail) { role in
                RoleDetailView(role: role)
                    .environmentObject(session)
            }
        }
    }
}

struct RoleDetailView: View {
    let role: Role
    @EnvironmentObject private var session: PhoneSession
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("职责") { Text(role.description) }
                if let tokens = role.budget?.perTask?.tokens {
                    Section("预算") { Text("每任务 \(tokens) tokens") }
                }
                Section("说明书") {
                    Text(role.skillExcerpt.isEmpty ? "没有摘录" : role.skillExcerpt)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle(role.name)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("选为岗位") {
                        session.selectRole(role)
                        dismiss()
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }
}
