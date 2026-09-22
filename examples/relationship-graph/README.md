# 关系图谱交互预览

使用合成数据，复用正式 `RelationshipGraph` 组件和中英文本。无真实连接、授权或调用，打开动作显示演示提示。

在仓库根目录完成 `npm ci && npm run build` 后运行：

```sh
npx vite --config examples/relationship-graph/vite.config.ts
```

打开 http://127.0.0.1:43827 。可测试搜索、实体/关系筛选、节点/边证据、一/二跳邻域、缩放拖动、刷新保持、明确跳转按钮、中文/English。

构建便携预览：`npx vite build --config examples/relationship-graph/vite.config.ts`。进入输出 `dist` 目录执行 `python3 -m http.server 43827 --bind 127.0.0.1` 后浏览该地址。ES modules 需要 HTTP 服务，不能直接双击 HTML。
