package com.bytefolk.roleweave

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID

data class Role(
    val id: String,
    val name: String,
    val description: String,
    val skillExcerpt: String,
)

data class Snapshot(
    val name: String,
    val description: String,
    val roles: List<Role>,
)

data class PhoneState(
    val host: String = "http://127.0.0.1:8800",
    val snapshot: Snapshot? = null,
    val status: String = "尚未连接电脑",
    val summary: String = "",
    val paired: Boolean = false,
    val error: String? = null,
)

class PhoneViewModel : ViewModel() {
    private val client = OkHttpClient()
    private val _state = MutableStateFlow(PhoneState())
    val state: StateFlow<PhoneState> = _state
    private var socket: WebSocket? = null
    private var deviceToken: String? = null

    fun setHost(value: String) {
        _state.update { it.copy(host = value) }
    }

    fun loadOrg() {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val request = Request.Builder()
                    .url(_state.value.host.trimEnd('/') + "/api/mobile/workspace")
                    .build()
                client.newCall(request).execute().use { response ->
                    val json = JSONObject(response.body?.string().orEmpty())
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
                    _state.update {
                        it.copy(
                            snapshot = Snapshot(json.getString("name"), json.optString("description"), list),
                            error = null,
                        )
                    }
                }
            } catch (_: Exception) {
                _state.update { it.copy(error = "组织预览读不到") }
            }
        }
    }

    fun pair(code: String) {
        viewModelScope.launch(Dispatchers.IO) {
            _state.update { it.copy(status = "正在配对…") }
            try {
                val body = JSONObject().put("code", code).toString()
                    .toRequestBody("application/json; charset=utf-8".toMediaType())
                val request = Request.Builder()
                    .url(_state.value.host.trimEnd('/') + "/phone-link/v1/pair")
                    .post(body)
                    .build()
                client.newCall(request).execute().use { response ->
                    val json = JSONObject(response.body?.string().orEmpty())
                    val token = json.optString("deviceToken")
                    if (!response.isSuccessful || token.isEmpty()) {
                        _state.update { it.copy(status = json.optString("message", "配对失败")) }
                        return@use
                    }
                    deviceToken = token
                    connectSocket()
                }
            } catch (_: Exception) {
                _state.update { it.copy(status = "配对失败") }
            }
        }
    }

    fun send(text: String, positionId: String?) {
        val socket = socket
        if (socket == null || !_state.value.paired) {
            _state.update { it.copy(status = "还没连上电脑") }
            return
        }
        val payload = JSONObject()
            .put("v", 1)
            .put("type", "command.submit")
            .put("commandId", UUID.randomUUID().toString())
            .put("text", text)
        if (!positionId.isNullOrEmpty()) payload.put("positionId", positionId)
        socket.send(payload.toString())
        _state.update { it.copy(status = "已发出，等电脑受理…") }
    }

    private fun connectSocket() {
        val http = _state.value.host.trimEnd('/')
        val ws = http.replace("https://", "wss://").replace("http://", "ws://") + "/phone-link/phone"
        val request = Request.Builder().url(ws).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                val hello = JSONObject()
                    .put("v", 1)
                    .put("type", "phone.hello")
                    .put("deviceToken", deviceToken)
                webSocket.send(hello.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val json = JSONObject(text)
                when (json.optString("type")) {
                    "phone.accepted" -> _state.update { it.copy(paired = true, status = "已连上电脑，可以发指令。") }
                    "command.status" -> {
                        val labels = mapOf(
                            "accepted" to "电脑已接到",
                            "running" to "员工正在处理",
                            "completed" to "完成",
                            "failed" to "失败",
                            "busy" to "该员工正在忙",
                            "needs_approval" to "请在电脑上确认",
                        )
                        val state = json.optString("state")
                        _state.update {
                            it.copy(
                                status = labels[state] ?: state,
                                summary = json.optString("summary", it.summary),
                            )
                        }
                    }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                _state.update { it.copy(paired = false, status = "连接断开") }
            }
        })
    }
}
