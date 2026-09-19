import Foundation
import Combine

struct WorkspaceSnapshot: Decodable {
    let name: String
    let description: String
    let owner: String?
    let roles: [Role]
}

struct Role: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
    let reportTo: String?
    let skillExcerpt: String
    let budget: Budget?

    struct Budget: Decodable, Hashable {
        let perTask: Limit?
        struct Limit: Decodable, Hashable { let tokens: Int? }
    }
}

@MainActor
final class PhoneSession: ObservableObject {
    @Published var host: String {
        didSet { UserDefaults.standard.set(host, forKey: Self.hostKey) }
    }
    @Published var bootToken: String {
        didSet { UserDefaults.standard.set(bootToken, forKey: Self.bootTokenKey) }
    }
    @Published var snapshot: WorkspaceSnapshot?
    @Published var selectedRoleId: String?
    @Published var status = "尚未连接电脑"
    @Published var summary = ""
    @Published var paired = false
    @Published var errorMessage: String?

    private var webSocket: URLSessionWebSocketTask?
    private var deviceToken: String? {
        didSet { UserDefaults.standard.set(deviceToken, forKey: Self.deviceTokenKey) }
    }
    private var reconnectAttempt = 0
    private var reconnectTask: Task<Void, Never>?

    private static let hostKey = "roleweave.phone.host"
    private static let bootTokenKey = "roleweave.phone.bootToken"
    private static let deviceTokenKey = "roleweave.phone.deviceToken"

    init() {
        host = UserDefaults.standard.string(forKey: Self.hostKey) ?? "http://127.0.0.1:8800"
        bootToken = UserDefaults.standard.string(forKey: Self.bootTokenKey) ?? ""
        deviceToken = UserDefaults.standard.string(forKey: Self.deviceTokenKey)
    }

    var selectedRole: Role? {
        snapshot?.roles.first { $0.id == selectedRoleId }
    }

    func loadOrg() async {
        errorMessage = nil
        guard let url = PhoneLinkCodec.workspaceURL(host: host) else {
            errorMessage = "主机地址无效"
            return
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: authorizedRequest(url: url))
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                errorMessage = httpStatusHint(response)
                return
            }
            snapshot = try JSONDecoder().decode(WorkspaceSnapshot.self, from: data)
            if let selectedRoleId, snapshot?.roles.contains(where: { $0.id == selectedRoleId }) != true {
                self.selectedRoleId = nil
            }
        } catch {
            errorMessage = "组织预览读不到"
        }
    }

    func pair(code: String) async {
        errorMessage = nil
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard PhoneLinkCodec.isValidPairCode(trimmed) else {
            errorMessage = "配对码必须是 6 位数字"
            status = "配对失败"
            return
        }
        status = "正在配对…"
        guard let url = PhoneLinkCodec.pairURL(host: host) else {
            errorMessage = "主机地址无效"
            return
        }
        var request = authorizedRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["code": trimmed])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = body["deviceToken"] as? String else {
                status = "配对失败"
                errorMessage = httpStatusHint(response)
                return
            }
            deviceToken = token
            reconnectAttempt = 0
            connectSocket()
        } catch {
            status = "配对失败"
        }
    }

    func sendCommand(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard paired, let webSocket else {
            status = "还没连上电脑"
            return
        }
        guard let positionId = selectedRoleId, !positionId.isEmpty else {
            status = "请先在组织页点选一个岗位"
            return
        }
        guard !trimmed.isEmpty else { return }
        let payload = PhoneLinkCodec.commandPayload(
            text: trimmed,
            positionId: positionId,
            commandId: UUID().uuidString
        )
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webSocket.send(.string(json)) { [weak self] error in
            Task { @MainActor in
                self?.status = error == nil ? "已发出，等电脑受理…" : "发送失败"
            }
        }
    }

    func selectRole(_ role: Role) {
        selectedRoleId = role.id
    }

    private func authorizedRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let value = PhoneLinkCodec.authorizationValue(bootToken: bootToken) {
            request.setValue(value, forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func httpStatusHint(_ response: URLResponse) -> String {
        guard let http = response as? HTTPURLResponse else { return "组织预览读不到" }
        if http.statusCode == 401 { return "需要 boot-token（401）" }
        return "请求失败（\(http.statusCode)）"
    }

    private func connectSocket() {
        guard let deviceToken,
              let wsURL = PhoneLinkCodec.socketURL(host: host) else { return }
        webSocket?.cancel(with: .goingAway, reason: nil)
        let task = URLSession.shared.webSocketTask(with: wsURL)
        webSocket = task
        task.resume()
        let hello = PhoneLinkCodec.helloPayload(deviceToken: deviceToken)
        if let data = try? JSONSerialization.data(withJSONObject: hello),
           let json = String(data: data, encoding: .utf8) {
            task.send(.string(json)) { [weak self] error in
                Task { @MainActor in
                    if error != nil { self?.scheduleReconnect() }
                }
            }
        }
        listen(task)
    }

    private func listen(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .failure:
                    self.scheduleReconnect()
                case .success(.string(let text)):
                    self.handleMessage(text)
                    self.listen(task)
                default:
                    self.listen(task)
                }
            }
        }
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        guard deviceToken != nil else {
            status = "连接断开"
            paired = false
            return
        }
        guard reconnectAttempt < PhoneLinkCodec.maxReconnectAttempts else {
            status = "连接断开"
            paired = false
            return
        }
        reconnectAttempt += 1
        let waitMs = PhoneLinkCodec.reconnectDelayMs(attempt: reconnectAttempt)
        status = "连接断开，正在重连（\(reconnectAttempt)/\(PhoneLinkCodec.maxReconnectAttempts)）…"
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(waitMs) * 1_000_000)
            guard !Task.isCancelled else { return }
            await self?.connectSocket()
        }
    }

    private func handleMessage(_ text: String) {
        guard let body = PhoneLinkCodec.parseMessage(text),
              let type = body["type"] as? String else { return }
        if type == "phone.accepted" {
            paired = true
            reconnectAttempt = 0
            status = "已连上电脑，可以发指令。"
        } else if type == "command.status" {
            let state = body["state"] as? String ?? ""
            status = PhoneLinkCodec.statusLabel(state)
            if let summary = body["summary"] as? String { self.summary = summary }
        }
    }
}
