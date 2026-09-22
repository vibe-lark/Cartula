# MCP App 底图与 Worker 兼容性

2026-09-19，针对豆包工作「卡片有路线、无底图；独立页面正常」的复现和修复。

## 证据与范围

Cartula 原来已把 MapLibre Worker 的完整依赖打包为 Blob，但产物是 ESM，MapLibre 6.7.0 以 `type: 'module'` 创建它。在 Chromium 145/148 的 opaque `srcdoc` iframe 中，这种 Worker 构造不抛错，却异步启动失败；即使明确允许 `worker-src blob:`，仍可复现。普通页面、带 `allow-same-origin` 的 iframe 正常。Claude 独立复现了这个差异，并验证了 classic Worker 在 Chromium 和 Firefox 中的兼容性。

路线由 deck.gl 绘制，不依赖这个 Worker；样式 JSON 在主线程加载。因此旧版会出现 `data-mode="webgl"`、`data-ready="true"`，却没有矢量瓦片和字体请求。生产公开样式、TileJSON、真实 PBF、字体和 sprite 的成功响应已有 `Access-Control-Allow-Origin: *`，未发现重定向。不存在的 `/tiles/0/0/0.png` 不能用来诊断当前 vector 部署的 CORS。

这是已复现的故障机制，真实豆包客户端仍须按下文验收。若客户端实际是 `data-mode="svg"` 且 CSP 拒绝 Worker，则属于另一条原因链，classic 本身无法解决宿主禁用 Worker。

## 实现

- 全平台共用严格模式 IIFE Worker，不按宿主名称分支。通过 MapLibre 的公开 `setWorkerUrl` 设置 Blob URL，附加 `#cartula-worker.cjs`，让 6.7.0 选择 classic；fragment 不改变 Blob 身份，不能替换为 query。这个选择规则属于 MapLibre 实现细节，升级时由真实浏览器回归保护。
- 每次 `style.load` 后添加一个空 GeoJSON source，让实际 Worker 完成一次无需联网的往返。只有收到对应 `sourcedata/content` 才判定 `ok`，随后移除 source。样式切换、`dataabort` 和卸载清理监听及计时器，独立 source ID 排除旧响应。
- 10 秒没有回复时显示「地图引擎暂未响应」，保留 WebGL 路线和编辑；迟到的有效回复会清除提示。明确的 Worker/CSP/引擎失败仍走已有 SVG 回退，并明确说明没有底图。`data-ready` 仍表示可以进行路线绘制与相机定位，不代表底图已成功。
- `.map-canvas` 提供 `data-worker` 读数；`CARTULA_DIAGNOSTICS=1` 的诊断面板同时显示渲染模式和 Worker 状态。Console 只额外记录固定诊断码，不输出 Worker 消息、地图内容或凭据。
- 已注册的 `/basemap/*`、`/tiles/:z/:x/:y.png` 通过路由 `onSend` 返回公共资源 CORS，错误和 handler 之前的限流响应也保留真实状态码。没有给业务 API 或 MCP 接口开放通配 CORS，也没有增加任意 URL 代理。

MCP 业务请求、`contents[]._meta.ui.csp`、标准尺寸协商和既有两个 Codex 高度 metadata 保持现有行为。这次不新增宿主协议、端口、iframe 权限或网络域名。

## 自动验证

```sh
npm run check
npx playwright test tests/e2e/map-worker.spec.ts --reporter=line
```

`map-worker.spec.ts` 使用真正的 Worker 和底图，分别覆盖普通网页、opaque MCP App、Worker 异步失败以及宿主 CSP 禁用 Worker。成功用例同时要求实际 classic Worker、`data-worker="ok"`、PBF 和字体成功响应；不把 style 就绪当作底图就绪。故障注入只存在测试代码中，产品不替换全局 `Worker`。

单元测试覆盖超时后恢复、样式替换、旧响应隔离、卸载清理、公共资源错误 CORS 和私有接口隔离。尺寸矩阵仍使用既有 `noWorkers` 场景；修改前抽查 5 项，4 项通过，520px elastic 场景存在 49px 横向溢出，作为既有问题记录。

本次本地验证：`npm run check` 通过（383 条测试、类型检查、Web 与 embed 构建）。13 项选定 E2E 中 12 项通过，含全部 4 项 Worker 用例、实际地图编辑、离线导出、MCP App 编辑和 WebGL 禁用回退；唯一失败仍为修改前同样的 520px / 49px 横向溢出。opaque 卡片截图已人工核对街道、地名和路线正常。

浏览器测试因服务地址是 loopback，单独关闭 Chromium 的 LocalNetworkAccessChecks；生产使用公开 HTTPS 资源，不要求用户或宿主关闭网络检查。

## 独立审核结论

Claude 先独立复现 Worker 故障、验证 classic 与实际 Worker 往返方案，再审查最终代码，结论为「同意，无阻断项、无必改项」。实现审核核对了 source 清理、迟到响应、公开 API 使用、CORS 路由范围、既有宿主 metadata 和行为测试，并独立抽查 5 条 Worker 状态单元测试全部通过。完整 383 条检查与 13 项 E2E 由主实现代理运行。

审核记录了一个不阻断的理论次序问题：若 `style.load` 在 CSP violation 与 React cleanup 之间到达，诊断的 `blocked` 可能被 `pending` 覆盖；当前浏览器执行顺序与禁止 Worker 的 E2E 未复现。此次保留已审核、已验证的最小实现，实机验收同时记录渲染模式和 CSP 报错，避免只凭一个诊断属性判断原因。

## 豆包客户端验收

1. 部署待验收构建后，重新读取工具声明指向的当前 `ui://` 资源，确认资源 build 已更新，避免命中旧卡片缓存。可在测试环境开启 `CARTULA_DIAGNOSTICS=1`。
2. 在实际卡片 iframe 内读取下列无凭据诊断值，不用侧边栏普通网页的结果代替卡片结果：

   ```js
   const canvas = document.querySelector('.map-canvas');
   ({ origin: self.origin, mode: canvas?.getAttribute('data-mode'),
      worker: canvas?.getAttribute('data-worker'),
      fallback: canvas?.getAttribute('data-fallback') });
   ```

3. 预期为 `mode: "webgl"`、`worker: "ok"`，卡片能看到街道/地名和路线。Network 应出现**当前 style / TileJSON 实际引用**的 PBF、字体、sprite 请求，并有成功响应。Worker 为 `ok` 只证明引擎往返正常，还须核对底图资源和视觉结果。
4. 若 `worker: "timeout"`，记录固定诊断码、实际 Worker 类型和错误事件；若 `mode: "svg"`、`worker: "blocked"`，核对宿主有效 CSP 是否允许 Blob Worker。不要要求新增 `allow-same-origin` 或扩大 CSP 来掩盖失败。
5. 若 Worker 正常、底图请求失败，区分实际 `connect-src` / `img-src` 拦截、CORS、HTTP 错误及重定向；记录请求路径类型和状态即可，不记录密钥、编辑链接或工具完整 payload。
6. 复测卡片缩放、编辑、样式切换及展开/返回；普通网页正常仍只是对照，不代表卡片已经通过。

真实豆包客户端通过上述验收后，才能关闭该反馈。当前本地模拟宿主测试不能替代豆包、Codex 或 Claude App 的实机验收。
