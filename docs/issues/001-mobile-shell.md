# 手机打开 RoleWeave 应是原生壳，而不是缩过的桌面

- Type: story
- Priority: P1
- Surface: ASteam 托管产品 / 手机 App

## What to build

手机或 ASteam App 打开产品根路径时，看到组织、发指令、桌面入口和设置，而不是 1240×800 的 VNC 桌面。桌面浏览器行为保持不变。

## Acceptance criteria

- [ ] iPhone / Android / `ASteamApp` 访问 `/` 得到手机壳（`data-surface="mobile"`）
- [ ] Macintosh 等桌面 UA 访问 `/` 仍是远程桌面
- [ ] `/?surface=mobile` 与 `/?surface=desktop` 可强制切换
- [ ] 组织页列出 oss-maintainer 四个岗位，响应不含主机路径
- [ ] 底栏四个入口，触控高度 ≥ 44px，尊重安全区
- [ ] `/healthz` 不变

## Blocked by

None - can start immediately
