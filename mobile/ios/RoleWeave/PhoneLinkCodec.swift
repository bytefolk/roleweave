import Foundation

enum PhoneLinkCodec {
    static let maxReconnectAttempts = 5

    static func reconnectDelayMs(attempt: Int) -> Int {
        let clamped = max(1, min(attempt, maxReconnectAttempts))
        return 1000 * (1 << (clamped - 1))
    }

    static func isValidPairCode(_ code: String) -> Bool {
        code.count == 6 && code.unicodeScalars.allSatisfy { CharacterSet.decimalDigits.contains($0) }
    }

    static func authorizationValue(bootToken: String) -> String? {
        let token = bootToken.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : "Bearer \(token)"
    }

    static func normalizedHost(_ host: String) -> String {
        host.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    static func workspaceURL(host: String) -> URL? {
        URL(string: normalizedHost(host) + "/api/mobile/workspace")
    }

    static func pairURL(host: String) -> URL? {
        URL(string: normalizedHost(host) + "/phone-link/v1/pair")
    }

    static func socketURL(host: String) -> URL? {
        guard let http = URL(string: normalizedHost(host)),
              var components = URLComponents(url: http, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = http.scheme?.lowercased() == "https" ? "wss" : "ws"
        components.path = "/phone-link/phone"
        return components.url
    }

    static func helloPayload(deviceToken: String) -> [String: Any] {
        ["v": 1, "type": "phone.hello", "deviceToken": deviceToken]
    }

    static func commandPayload(text: String, positionId: String, commandId: String) -> [String: Any] {
        [
            "v": 1,
            "type": "command.submit",
            "commandId": commandId,
            "text": text,
            "positionId": positionId,
        ]
    }

    static func parseMessage(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              body["type"] as? String != nil else { return nil }
        return body
    }

    static func statusLabel(_ state: String) -> String {
        let labels = [
            "accepted": "电脑已接到",
            "running": "员工正在处理",
            "completed": "完成",
            "failed": "失败",
            "busy": "该员工正在忙",
            "needs_approval": "请在电脑上确认",
        ]
        return labels[state] ?? state
    }
}
