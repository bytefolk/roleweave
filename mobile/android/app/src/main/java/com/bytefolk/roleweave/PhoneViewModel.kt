package com.bytefolk.roleweave

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
import java.util.concurrent.TimeUnit

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
    val selectedRoleId: String? = null,
    val status: String = "尚未连接电脑",
    val summary: String = "",
    val paired: Boolean = false,
    val error: String? = null,
)

class PhoneViewModel : ViewModel() {
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val _state = MutableStateFlow(PhoneState())
    val state: StateFlow<PhoneState> = _state
    private var socket: WebSocket? = null
    private var deviceToken: String? = null
    private var reconnectJob: Job? = null
    private var reconnectAttempt = 0
    private var stopReconnect = false

    fun setHost(value: String) {
        _state.update { it.copy(host = value) }
    }

    fun selectRole(id: String) {
        _state.update { it.copy(selectedRoleId = id) }
    }

    fun loadOrg() {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val request = Request.Builder()
                    .url(_state.value.host.trimEnd('/') + "/api/mobile/workspace")
                    .build()
                client.newCall(request).execute().use { response ->
                    val body = response.body?.string().orEmpty()
                    if (!response.isSuccessful) {
                        Log.e(TAG, "loadOrg HTTP ${response.code}")
                        _state.update { it.copy(error = "组织预览读不到") }
                        return@use
                    }
                    val snapshot = PhoneLinkCodec.parseSnapshot(body)
                    _state.update {
                        val stillValid = it.selectedRoleId?.takeIf { id ->
                            snapshot.roles.any { role -> role.id == id }
                        }
                        it.copy(
                            snapshot = snapshot,
                            selectedRoleId = stillValid,
                            error = null,
                        )
                    }
                }
            } catch (error: Exception) {
                Log.e(TAG, "loadOrg failed", error)
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
                        Log.e(TAG, "pair HTTP ${response.code}")
                        _state.update { it.copy(status = json.optString("message", "配对失败")) }
                        return@use
                    }
                    deviceToken = token
                    stopReconnect = false
                    reconnectAttempt = 0
                    connectSocket()
                }
            } catch (error: Exception) {
                Log.e(TAG, "pair failed", error)
                _state.update { it.copy(status = "配对失败") }
            }
        }
    }

    fun send(text: String) {
        val roleId = _state.value.selectedRoleId
        if (roleId.isNullOrEmpty()) {
            _state.update { it.copy(status = "先在组织里选一个岗位") }
            return
        }
        val socket = socket
        if (socket == null || !_state.value.paired) {
            _state.update { it.copy(status = "还没连上电脑") }
            return
        }
        socket.send(PhoneLinkCodec.commandPayload(UUID.randomUUID().toString(), text, roleId))
        _state.update { it.copy(status = "已发出，等电脑受理…") }
    }

    private fun connectSocket() {
        val token = deviceToken ?: return
        val http = _state.value.host.trimEnd('/')
        val ws = http.replace("https://", "wss://").replace("http://", "ws://") + "/phone-link/phone"
        val request = Request.Builder().url(ws).build()
        socket?.cancel()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                reconnectAttempt = 0
                webSocket.send(PhoneLinkCodec.helloPayload(token))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val json = JSONObject(text)
                when (json.optString("type")) {
                    "phone.accepted" -> _state.update { it.copy(paired = true, status = "已连上电脑，可以发指令。") }
                    "command.status" -> {
                        val state = json.optString("state")
                        _state.update {
                            it.copy(
                                status = PhoneLinkCodec.commandStatusLabel(state),
                                summary = json.optString("summary", it.summary),
                            )
                        }
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                Log.e(TAG, "websocket failed", t)
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.e(TAG, "websocket closed $code")
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (stopReconnect || deviceToken == null) {
            _state.update { it.copy(paired = false, status = "连接断开") }
            return
        }
        if (reconnectAttempt >= 5) {
            _state.update { it.copy(paired = false, status = "连接断开，请重新配对") }
            return
        }
        reconnectAttempt += 1
        val waitMs = PhoneLinkCodec.reconnectDelayMs(reconnectAttempt)
        _state.update { it.copy(paired = false, status = "连接断开，正在重连…") }
        reconnectJob?.cancel()
        reconnectJob = viewModelScope.launch {
            delay(waitMs)
            connectSocket()
        }
    }

    override fun onCleared() {
        stopReconnect = true
        reconnectJob?.cancel()
        socket?.cancel()
        super.onCleared()
    }

    private companion object {
        const val TAG = "RoleWeave"
    }
}
