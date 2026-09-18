# phone-link.v1

手机发一条指令，已经打开的 RoleWeave（或任何实现本协议的宿主）立刻处理。

电脑不对外开端口：宿主和手机都**主动连**中继。中继只转发，不跑员工、不长期存正文。

## 以后的软件怎么用

1. 电脑进程连 `ws(s)://<relay>/phone-link/host`，首条消息：

   ```json
   { "v": 1, "type": "host.hello", "token": "<64-hex host token>" }
   ```

2. 发 `{ "v": 1, "type": "pair.start" }`，把返回的 6 位 `code` 显示给用户。

3. 手机打开产品（手机壳「指令」或 `/command`）：

   - 同一产品地址：`POST /phone-link/v1/claim` → `{ "deviceId", "deviceToken" }`（电脑必须已连中继）
   - 或 `POST /phone-link/v1/pair` `{ "code": "482910" }`（电脑弹窗里的 6 位码）

   发现：`GET /phone-link/v1/status` → `{ "schema", "hostOnline", "deviceCount" }`

   然后连 `ws(s)://<relay>/phone-link/phone`，首条：

   ```json
   { "v": 1, "type": "phone.hello", "deviceToken": "<token>" }
   ```

4. 提交指令：

   ```json
   { "v": 1, "type": "command.submit", "commandId": "<uuid>", "text": "…", "positionId": "optional-role-id" }
   ```

5. 状态回推 `command.status`：`accepted` → `running` → `completed` | `failed` | `busy` | `needs_approval`。`completed` 可带 `summary`。

发现：`GET /phone-link/v1/protocol` → `{ "schema": "phone-link.v1" }`。

## 不变式

- 电脑必须已经在跑；宿主掉线则指令失败，不排队。
- 一个员工同一时刻只接一条（忙则 `busy`）。
- 危险操作仍在电脑上批准；手机只看到 `needs_approval`。
- 电脑打开工作区后，宿主推送 `org.snapshot`；手机 `GET /api/mobile/workspace` 读这份快照，不含主机路径。
- 手机可 `POST /phone-link/v1/revoke` `{ "deviceToken" }` 撤销自己。
- 配对码 5 分钟作废；设备许可可 `pair.revoke`。
- 指令正文 ≤ 8 KiB UTF-8。
