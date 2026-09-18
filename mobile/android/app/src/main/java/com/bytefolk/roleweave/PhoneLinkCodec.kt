package com.bytefolk.roleweave

import org.json.JSONObject

object PhoneLinkCodec {
    fun parseSnapshot(raw: String): Snapshot {
        val json = JSONObject(raw)
        val roles = json.getJSONArray("roles")
        val list = buildList {
            for (i in 0 until roles.length()) {
                val item = roles.getJSONObject(i)
                add(
                    Role(
                        id = item.getString("id"),
                        name = item.getString("name"),
                        description = item.optString("description"),
                        skillExcerpt = item.optString("skillExcerpt"),
                    )
                )
            }
        }
        return Snapshot(
            name = json.getString("name"),
            description = json.optString("description"),
            roles = list,
        )
    }

    fun helloPayload(deviceToken: String): String =
        JSONObject()
            .put("v", 1)
            .put("type", "phone.hello")
            .put("deviceToken", deviceToken)
            .toString()

    fun commandPayload(commandId: String, text: String, positionId: String?): String {
        val payload = JSONObject()
            .put("v", 1)
            .put("type", "command.submit")
            .put("commandId", commandId)
            .put("text", text)
        if (!positionId.isNullOrEmpty()) payload.put("positionId", positionId)
        return payload.toString()
    }

    /** Exponential backoff: 1s, 2s, 4s, 8s, 16s for attempts 1..5. */
    fun reconnectDelayMs(attempt: Int): Long {
        val n = attempt.coerceAtLeast(1).coerceAtMost(16)
        return 1000L shl (n - 1)
    }

    fun commandStatusLabel(state: String): String =
        when (state) {
            "accepted" -> "电脑已接到"
            "running" -> "员工正在处理"
            "completed" -> "完成"
            "failed" -> "失败"
            "busy" -> "该员工正在忙"
            "needs_approval" -> "请在电脑上确认"
            else -> state
        }
}
