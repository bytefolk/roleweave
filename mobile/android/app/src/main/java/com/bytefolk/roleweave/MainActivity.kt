package com.bytefolk.roleweave

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
    private val model by viewModels<PhoneViewModel>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                RoleWeaveApp(model)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoleWeaveApp(model: PhoneViewModel) {
    var tab by remember { mutableIntStateOf(0) }
    val state by model.state.collectAsState()
    LaunchedEffect(Unit) { model.loadOrg() }
    Scaffold(
        topBar = {
            TopAppBar(title = {
                Text(
                    when (tab) {
                        0 -> state.snapshot?.name ?: "组织"
                        1 -> "指令"
                        else -> "设置"
                    }
                )
            })
        },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(selected = tab == 0, onClick = { tab = 0 }, icon = { Text("组") }, label = { Text("组织") })
                NavigationBarItem(selected = tab == 1, onClick = { tab = 1 }, icon = { Text("令") }, label = { Text("指令") })
                NavigationBarItem(selected = tab == 2, onClick = { tab = 2 }, icon = { Text("设") }, label = { Text("设置") })
            }
        }
    ) { padding ->
        when (tab) {
            0 -> OrgScreen(state, model, Modifier.padding(padding))
            1 -> CommandScreen(state, model, Modifier.padding(padding))
            else -> SettingsScreen(Modifier.padding(padding))
        }
    }
}

@Composable
fun OrgScreen(state: PhoneState, model: PhoneViewModel, modifier: Modifier = Modifier) {
    var selected by remember { mutableStateOf<Role?>(null) }
    if (selected != null) {
        Column(modifier.padding(16.dp).fillMaxSize()) {
            Text(selected!!.name, style = MaterialTheme.typography.headlineSmall)
            Text(selected!!.description, modifier = Modifier.padding(top = 8.dp))
            Text(selected!!.skillExcerpt.ifEmpty { "没有摘录" }, modifier = Modifier.padding(top = 12.dp), style = MaterialTheme.typography.bodySmall)
            Button(onClick = { selected = null }, modifier = Modifier.padding(top = 16.dp)) { Text("返回") }
        }
        return
    }
    LazyColumn(modifier.fillMaxSize()) {
        state.error?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) } }
        items(state.snapshot?.roles.orEmpty()) { role ->
            ListItem(
                headlineContent = { Text(role.name + if (role.id == state.selectedRoleId) "  · 已选" else "") },
                supportingContent = { Text(role.description) },
                modifier = Modifier.clickable {
                    model.selectRole(role.id)
                    selected = role
                }
            )
        }
    }
}

@Composable
fun CommandScreen(state: PhoneState, model: PhoneViewModel, modifier: Modifier = Modifier) {
    var code by remember { mutableStateOf("") }
    var text by remember { mutableStateOf("") }
    Column(modifier.padding(16.dp).fillMaxWidth()) {
        OutlinedTextField(state.host, onValueChange = model::setHost, label = { Text("RoleWeave 地址") }, modifier = Modifier.fillMaxWidth())
        Text(state.status, modifier = Modifier.padding(vertical = 12.dp))
        if (!state.paired) {
            OutlinedTextField(code, onValueChange = { code = it }, label = { Text("6 位配对码") }, modifier = Modifier.fillMaxWidth())
            Button(onClick = { model.pair(code) }, modifier = Modifier.padding(top = 12.dp).fillMaxWidth()) { Text("配对这台电脑") }
        } else {
            OutlinedTextField(text, onValueChange = { text = it }, label = { Text("指令") }, modifier = Modifier.fillMaxWidth(), minLines = 4)
            val selectedName = state.snapshot?.roles?.firstOrNull { it.id == state.selectedRoleId }?.name
            Text(if (selectedName == null) "先在组织里选一个岗位" else "发给 $selectedName")
            Button(
                onClick = {
                    model.send(text)
                    text = ""
                },
                modifier = Modifier.padding(top = 12.dp).fillMaxWidth()
            ) { Text("发给电脑") }
        }
        if (state.summary.isNotEmpty()) {
            Text(state.summary, modifier = Modifier.padding(top = 16.dp))
        }
    }
}

@Composable
fun SettingsScreen(modifier: Modifier = Modifier) {
    Column(modifier.padding(16.dp)) {
        Text("平台  Android")
        Text("回合  在电脑上执行")
        Text("组织  只读预览")
    }
}
