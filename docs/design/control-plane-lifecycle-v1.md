# Control Plane 生命周期 v1

这是 Electron shell 与本地 server 之间的最小生命周期契约。它解决的是“应用看见了一个子进程”与“控制面真的可用”之间的差异，不改变业务 API 或 token 的归属。

## 启动

桌面壳启动本地 server 后，只接受一行：

```text
org-workbench-server ready {"api":"v0","port":12345,"token":"<64 lowercase hex>"}
```

READY 必须同时满足：

- `api` 为 `v0`；
- `port` 为 1–65535 的整数；
- `token` 为 64 位小写十六进制字符串；
- JSON 不得携带未声明字段。

格式错误、进程提前退出或超时都会 fail closed，并主动清理子进程。

## 状态

Desktop IPC `owb:status` 对外只投影以下状态：

```text
starting → ready ⇄ degraded
    └────→ failed
ready/degraded → stopping → stopped
```

`ready` 需要同时满足真实 child 仍存活，以及 `/health` 返回 `200`、`status=ok`、`api=v0`。进程对象存在但已经退出时，必须返回 `running=false`，不能把失联控制面报告为运行中。

## 停止

停止是幂等操作：

1. 向控制面进程组发送 `SIGTERM`（Windows 使用 child kill）；
2. 在有界时间内等待 `exit`；
3. 超时后升级为 `SIGKILL` 并继续等待；
4. 只有收到退出事件后才视为 `stopped`。

POSIX 原生桌面子进程作为独立进程组启动，以便退出时一并回收它拥有的 provider/driver 后代；WSL/Windows 继续使用平台对应的 child 终止路径。

## 验证

`apps/desktop/test/control-plane-lifecycle.test.cjs` 覆盖：严格 READY、READY 超时清理、幂等 stop、真实 server `READY → /health → stop → 端口释放`。实现位于 `apps/desktop/src/control-plane-lifecycle.cjs`，并由 `apps/desktop/packaging/runtime-layout.cjs` 显式打包。
