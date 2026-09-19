import SwiftUI

struct CommandView: View {
    @EnvironmentObject private var session: PhoneSession
    @State private var code = ""
    @State private var text = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("电脑") {
                    TextField("RoleWeave 地址", text: $session.host)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    SecureField("boot-token（桌面控制面）", text: $session.bootToken)
                        .textInputAutocapitalization(.never)
                    Text(session.status).foregroundStyle(.secondary)
                }
                if !session.paired {
                    Section("配对") {
                        TextField("6 位配对码", text: $code)
                            .keyboardType(.numberPad)
                            .onChange(of: code) { _, newValue in
                                let digits = newValue.filter(\.isNumber)
                                code = String(digits.prefix(6))
                            }
                        Button("配对这台电脑") {
                            Task { await session.pair(code: code) }
                        }
                        .disabled(!PhoneLinkCodec.isValidPairCode(code))
                    }
                } else {
                    Section("指令") {
                        if let role = session.selectedRole {
                            Text("岗位：\(role.name)").foregroundStyle(.secondary)
                        } else {
                            Text("请先在组织页点选一个岗位").foregroundStyle(.red)
                        }
                        TextField("例如：看一下还开着的 PR", text: $text, axis: .vertical)
                            .lineLimit(4...8)
                        Button("发给电脑") {
                            session.sendCommand(text)
                            text = ""
                        }
                        .disabled(session.selectedRoleId == nil || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                if !session.summary.isEmpty {
                    Section("结果") { Text(session.summary) }
                }
            }
            .navigationTitle("指令")
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var session: PhoneSession

    var body: some View {
        NavigationStack {
            List {
                LabeledContent("平台", value: "iOS")
                LabeledContent("回合", value: "在电脑上执行")
                LabeledContent("组织", value: "只读预览")
                Section("连接") {
                    TextField("RoleWeave 地址", text: $session.host)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    SecureField("boot-token", text: $session.bootToken)
                        .textInputAutocapitalization(.never)
                }
            }
            .navigationTitle("设置")
        }
    }
}
