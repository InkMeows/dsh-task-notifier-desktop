# dsh-task-notifier-desktop

DSH 桌面端的任务通知插件。**当前主线版本。** 任务跑完一轮、或在后台会话完成、
或模型需要你手动输入（提问 / 权限审批 / 计划评审）时，弹出**系统级通知**
（OS 原生 toast），点击直达对应会话。

包名带 `-desktop`，因为它只面向安装版桌面端（Electron + dsh 0.2.x 线）：
peer 范围锁在 `^0.2.1-rc.1`，构建对照桌面端打包的 dsh **0.2.1-rc.2**。

Web 端的同名插件 `@dsh-external/dsh-task-notifier`（跑 0.1.7-alpha.2 profile）
**已弃用**，不再维护。下文保留的隔离矩阵与"沿用 Web 端"的记录只作解释用。

---

## 1. 为什么必须做版本隔离（peer 兼容性闸门）

dsh 0.2.0-rc.2 的 `dsh-app-boot` 新增了插件兼容性闸门
（`evaluatePluginCompatibility`，`dsh-app-boot/lib/index.js:286-313`）。对每一个
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 都要求：

```js
semver.satisfies(runtimeVersion, range, { includePrerelease: true })
```

不满足的 bundle 会被**整层跳过**（`loadProfileDirectory` 把它塞进 `profile.skippedBundles`，
loader row 随后被 disable）——插件不是"半加载"，而是**直接消失**。

用桌面端自带的 semver 7.8.5 实测（`tests/desktop-verify.mjs` 里跑了同样的判定）：

| peer 范围 | 0.2.1-rc.2 |
| --- | --- |
| `^0.1.7-alpha.2`（已弃用的 Web 包） | **false** —— caret 被规范化成 `>=0.1.7-alpha.2 <0.2.0-0` |
| `^0.2.1-rc.1`（本包） | **true** |

所以 0.1.7 线的包装不进 desktop profile（会**静默失效**）；本包自带 0.2.x 的
peer 范围、自己的包身份和自己的构建产物。

`tests/desktop-verify.mjs` 同时断言两个方向：闸门**接受本包**、**拒绝 0.1.7 线的包**；
Web 源码已于 2026-10-17 移除，该对照组在源码缺席时降级为 skip。

---

## 2. 隔离矩阵

| 项 | 已弃用的 Web 包 | 本包 |
| --- | --- | --- |
| 目录 | —（2026-10-17 已移除） | `../dsh-task-notifier-desktop` |
| 包名 | `@dsh-external/dsh-task-notifier` | `@dsh-external/dsh-task-notifier-desktop` |
| 版本 | `0.0.1` | `0.2.1-desktop.1` |
| dsh peers | `^0.1.7-alpha.2` | `^0.2.1-rc.1` |
| loader row id | `task-notifier` | `task-notifier-desktop` |
| client bundle id | `@dsh-external/dsh-task-notifier` | `@dsh-external/dsh-task-notifier-desktop` |
| locale 命名空间 | `taskNotifier` | `taskNotifierDesktop` |
| 侧边栏 slot entry id | `task-notifier-toggle` | `task-notifier-toggle-desktop` |
| 设置键 | `dsh-task-notifier:settings` | `dsh-task-notifier-desktop:settings` |
| 去重键前缀 | `dsh-task-notifier:last` | `dsh-task-notifier-desktop:last` |
| 安装位置 | — | `profiles/desktop` |

隔离到"设置键"这一层，意味着**即使**将来某个 profile 同时列了两个 bundle，
也不会出现"同一个开关控制两个插件""去重窗口互相吃掉"这类隐蔽耦合。
`tests/desktop-verify.mjs` 与 `tests/isolation.test.mjs` 会持续断言这十项互不重叠。

---

## 3. 桌面端环境差异（以及本包对应的处理）

| 环境事实 | 证据 | 本包的处理 |
| --- | --- | --- |
| 页面来源是 Electron 私有协议 `dsh-app://app/`，且注册为 `standard + secure` | `main.js:11019-11029`、`main.js:11542-11551` | `isDesktopShell()` 按 `location.protocol === 'dsh-app:'` 判定，用于权限文案与日志 |
| 非 `media` 权限由 shell 直接放行，通知无需站点授权 | `main.js:6274-6296`（`setPermissionRequestHandler`：`permission !== "media" → callback(true)`） | 保留 `Notification.requestPermission()` 兜底，但文案改指"由桌面应用授予"，不再让用户去翻浏览器站点设置 |
| `sidebar.footer.action` 是 `kind: "list"` 插槽（可并列多项） | `dsh-cordis-client-runner/lib/client.js`（slot 契约） | 用**独立 entry id** 注册，与已有的 footer action（如 `cordis-panel`）并存，不抢占 |
| 会话行由 `uiSession.sessionStatus` 统一发布 `running / pendingInteraction / completionUnread` | `dsh-client-ui-session/lib/client.js`（`super(ctx, "uiSession")`、`sessionStatus`、`publishStatus`） | 直接消费该公开源；同时保留旧版 `pendingInteractions` 读取分支作为降级 |
| `uiWorkspace.openSession(id)` 仍是公开导航能力 | `dsh-client-ui-workspace/lib/client.js:821` | 通知点击后调用它直达会话 |
| 关窗是**隐藏到托盘**而不是退出，renderer 仍存活 | `main.js:12028-12038` | 托盘/最小化时 `document.hasFocus()` 为 false，通知照常触发，符合 Codex 式"只在失焦时打扰" |
| preload 桥（`window.dshDesktop`）**没有**提供窗口 show/restore | `preload-app.cjs:789-842`（只有 browser / deviceInfo / keyboard / shortcuts / updates）；shell 只在 macOS `activate`、`second-instance`、`dsh://open` 时调 `focusPrimaryWindow()`（`main.js:12165-12196`） | 点击通知后仍用 `window.focus()`；**但它无法把已被 shell `hide()` 到托盘的窗口重新显示出来**——这是明确记录的限制，不是保证 |
| 系统 toast 自己会响 | Electron 把 `NotificationOptions.silent` 映射到 toast 音频 | `sound` 直接映射到 `silent`：`false` 是真正静音，`true` 交给系统提示音；WebAudio 蜂鸣只在"没有系统通知、退回标题闪烁"时使用 |
| 新增：`displayTitle` 可能缺失（全新/空白会话） | `dsh-client-ui-workspace/lib/client.js:4210` 用 `?.displayTitle ?? sessionId` 兜底 | `sessionTitleOf()` 在标题为空时回落到会话 id，不再弹空标题 |

---

## 4. 行为

- **只在窗口失焦时通知**：`document.hasFocus()` 为真时绝不打扰；
- **点击通知** → 尝试聚焦窗口 + 打开对应会话（见 §3 与 §10 的托盘限制）；
- **去重**：同一事件 3 秒内不重复（localStorage 跨窗口共享）；
- **声音**：`sound` 映射到 toast 的 `silent` —— `false` 完全静音，`true` 用系统提示音；
  只有在拿不到系统通知、退回标题闪烁时才播放 WebAudio 双音；
- **降级**：未授权系统通知时用 `document.title` 闪烁（+ 可选双音提示音，无资源文件）；
- **侧边栏底部开关**：展开显示"通知已**开**/**关**"，折叠只显示 **开**/**关**；
  悬停提示当前权限状态；点击即切换总开关，并作为用户手势请求权限。

### 开关的视觉

样式（沿用 Web 版）：浅色 1px 边框 + 8px 圆角 + 透明底，`color` 继承侧边栏文字色，
只让 **开/关** 那个字带饱和度（绿 / 红）。

> **已回退的实验**：曾按"淡化 / 透明"反馈改过一版（无边框 + `--dsw-alias-label-tertiary` + `opacity:.75`），
> 随后按要求撤回，`lib/client.js` 与源码都已回到原样。
>
> 排查结论（供以后参考）：桌面端 footer 的两个容器
> `footArea` / `footerActions` **没有** background / gradient / box-shadow；
> 侧边栏底部附近**唯一**存在的渐变是出厂 `@deepseek-ai/dsh-client-ui-workspace` 里会话列表自带的 24px 渐隐条：
>
> ```css
> ._9lTDKa_fade { height:24px; position:absolute; bottom:0;
>   background:linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill)); }
> ```
>
> 它渐隐到**侧边栏自己的底色**，因此在纯色主题下不可见，只在列表内容滚动到它下面时起到遮罩作用。
> 这是宿主 chrome，不是本插件画的。

### 压制会话列表底部那条黑雾（`_fade` 覆盖）

在**半透明 / 壁纸主题**下（本机是 Oh My DSH），侧边栏实际画出来的底色与
`--dsw-specific-sidebar-fill` 不再一致，于是那条渐隐条会变成一道**黑雾**，
而且它正好落在侧边栏 footer 的上边缘，也就是本插件开关的正上方。

插件因此注入**一条**样式（随 fiber 一起移除）：

```css
[class$="_fade"] { display: none !important }
```

选择器为什么是安全的：CSS Modules 生成 `<hash>_<localName>`，会话列表那条的 local name 是 `fade`，
而聊天记录上下渐隐是 `fadeTop` / `fadeBottom`、附件动画是 `fade-in` —— **只有列表那条以 `_fade` 结尾**。
该元素是 `position:absolute`，隐藏它不会改变任何布局，唯一影响是列表底部不再对滚动内容做遮罩。
若将来 DSH 改了类名，规则自然失配、黑雾复原，**不会报错也不会挡住别的 UI**。

对应的回归测试：`tests/compatibility.test.mjs` →
*the session-list fade override is injected and removed with the plugin*（断言注入的标签、选择器与移除行为，
并断言选择器**不**包含 `fadeTop` / `fadeBottom` / `fade-in`）。

**要恢复宿主原样**：删掉 `src/client/index.ts` 里的 `suppressSessionListFade()` 与 `apply()` 中那一行
`ctx.effect(...)`，然后 `pnpm run build:client`。

触发信号（全部来自宿主公开 API）：

| 场景 | 信号 |
| --- | --- |
| 后台会话跑完一轮 | `uiSession.sessionStatus` 的 `completionUnread` 上升沿 |
| 当前选中会话任务结束 | 选中会话的 `running` 下降沿 |
| 模型提问 / 权限审批 / 计划评审 | `pendingInteraction.kind` 的新 key |

---

## 5. 配置（localStorage，刷新页面后生效）

```jsonc
localStorage.setItem('dsh-task-notifier-desktop:settings', JSON.stringify({
  "enabled": true,               // 总开关（侧边栏按钮同时控制）
  "notifyOnlyWhenHidden": true,   // 仅窗口失焦时通知
  "sound": false                  // 通知同时播放提示音
}))
```

注意键名带 `-desktop`，与 Web 版配置**互不影响**。

---

## 6. 构建

```bash
pnpm install
pnpm run build          # host (tsc) → lib/index.js ; client (tsdown) → lib/client.js
pnpm run typecheck      # host 半边
node node_modules/typescript/bin/tsc -p tsconfig.client.json   # client 半边（DOM 类型）
```

> 比 Web 版多了一个 `tsconfig.client.json`：Web 包的 `typecheck` 只覆盖 host 入口，
> 浏览器源码从不做类型检查。本包把它补上了（`pnpm run typecheck` 之外单独跑，
> 因为 client 需要 DOM lib 而 host 需要 node types）。

---

## 7. 安装到桌面端 profile

```bash
node scripts/profile-wiring.mjs --check      # 只读：报告当前接线状态
node scripts/profile-wiring.mjs --apply      # 备份 → 改 package.json → pnpm install
node scripts/profile-wiring.mjs --rollback   # 还原备份并移除 link
```

`--apply` 只做**加法**：

1. `profiles/desktop/package.json` 增加一条 `link:` 依赖，并把包名追加进 `dsh.profile.bundles`；
2. 备份 `package.json` / `pnpm-lock.yaml` 为 `*.bak-before-task-notifier-desktop`；
3. 在 profile 目录跑 `pnpm install`（只新增 link 条目；lockfile 由 pnpm 自己更新）。

它**不碰** `cordis.patch.yml`（本包 host 半边是 no-op，没有需要 pin 的配置），
也不碰 `trisoul_x`、`dsh-web-search-multi-desktop` 和 Web profile。

⚠️ **新增 bundle 必须重启桌面端才能生效**：`dsh.profile.bundles` 在启动时读取一次，
桌面端没有 live bundle reload。

---

## 8. 验证

```bash
pnpm test                            # 依次跑完下面三套并汇总退出码
node tests/compatibility.test.mjs   # 11 项：bundle 行为（vm 沙箱，假 Notification/window/document/react）
node tests/desktop-verify.mjs       # 33 项：闸门 / bundle 身份 / host 半边 / loader row / profile 接线 / 标识符隔离 / 组合出的 loader rows
node tests/isolation.test.mjs       # 6 项：与本机已装插件的标识符、模块 id、slot 冲突扫描（含 app.asar 扫描）
```

三套都是**离线**的：不启动桌面端、不发真实通知、不访问网络，也不需要 DSH 源码树。

> `pnpm test` 走 `tests/run-all.mjs`（而不是 `A && B && C`）：后者在前一套失败时会**静默跳过**后面的套件，
> 让"隔离测试没跑"和"隔离测试失败"看起来一样。

`isolation.test.mjs` 会直接扫 `D:\DeepSeek Harness\resources\app.asar`，
证明本包用的六个标识符在**出厂客户端里一次都没出现过**，
并证明 `sidebar.footer.action` 的声明条目确实是 `kind: "list"`。

`desktop-verify.mjs` 里的 peer 版本不是写死的：它读 `app.asar` 内的
`@deepseek-ai/dsh-app-boot/package.json`（即 `getDshRuntimeVersion()` 读的同一处），
所以桌面端升级后这个校验不会继续拿旧版本号对比。

### 8.1 本机实测（非离线）

桌面端重启后本包已实际工作，证据如下（只读读取，未写入宿主）：

| 证据 | 内容 |
| --- | --- |
| Electron localStorage（`%APPDATA%\@deepseek-ai\dsh-desktop\Local Storage\leveldb`，来源 `__dsh-app://app`） | `dsh-task-notifier-desktop:last:end:session-d1322303-…` = `1790833656022`、`dsh-task-notifier-desktop:last:end:session-47092752-…` = `1790834842281` |
| 同一 leveldb 的负对照 | 没有任何 `dsh-task-notifier:`（Web 端）键 |
| Windows 通知数据库（`wpndatabase.db`） | toast 记录 tag = `n#dsh-app://app#end:session-47092752-dfc1-46ea-8ba5-118716bbadca`；`dsh-app://app` 在库中出现 **2** 次，均属本插件 |

这三条一起证明：bundle 被 loader 接受、客户端半边激活（五个服务全部就绪）、
watcher 跑起来并识别出"选中会话 running→idle"边沿、**焦点门控放行且 Windows 真的弹出了 toast**
（若门控拦截，localStorage 仍会留戳但通知数据库不会有记录——两边都有，才说明真的弹了）。

复现命令：`node .recon/live-notification-evidence.mjs`（工作区根目录，只读）。

---

## 9. 故障排查

1. **侧边栏没有开关**：先确认桌面端**重启过**（见 §7），再确认 profile 接线：
   `node scripts/profile-wiring.mjs --check` 应输出 `WIRED`。
2. **开关在但从不弹窗**：这是设计行为——窗口聚焦时不通知。切到别的应用 / 最小化 / 收进托盘才会弹。
3. **权限显示"已拒绝"**：桌面端的通知权限由 Electron session 授予；
   若被系统层拦截，到 `Windows 设置 → 系统 → 通知` 里允许 DeepSeek Harness。
4. **没有任何事件**：通知只发生在任务完成 / 结束 / 提问 / 审批 / 计划评审之后。
5. **想临时停用而不卸载**：侧边栏开关点一下即可（写入 localStorage），或 `--rollback` 彻底回退。

---

## 10. 已知限制

- **Windows toast 可用性：已在本机实测通过**（见 §8.1）。机制上 Electron 没有显式
  `app.setAppUserModelId`（整个 asar 里 0 次），Windows 侧登记的是 Electron 默认 AUMID
  `electron.app.DeepSeek Harness`，本机存在开始菜单快捷方式 `DeepSeek Harness.lnk`。
  换机器/换安装方式时仍以"首条 toast 实测"为准。
- **点击通知无法把"已收进托盘"的窗口叫回来**：preload 不提供 show/restore，
  shell 只在 macOS `activate`、`second-instance`、`dsh://open` 时重显窗口，
  渲染进程的 `window.focus()` 对 `hide()` 过的窗口无效。窗口只是被别的应用挡住时，`window.focus()` 有效。
  要彻底解决需要 desktop 侧加一个 IPC（本包不改宿主）。
- **`document.hasFocus()` 的托盘/最小化取值仍属推断**：已实测"未聚焦 → 放行并弹 toast"，
  但没有在托盘隐藏那一瞬观测窗口状态。若出现"正看着 GUI 还弹"，应改为监听 window blur 事件。
- **从 Web 端继承的两处去重怪癖**（本包刻意保持行为一致，未单方面改）：
  去重戳在焦点门控**之前**写入（被门控拦下的事件会消耗 3 秒窗口）；
  `pending` 事件的去重 tag 不含 `interaction.key`（同一会话 3 秒内的第二个提问/审批会被吞掉）。
- **host half 的 `Config` 是死代码**：`enabled/notifyOnlyWhenHidden/sound` 只在 schema 里，
  客户端只读 localStorage；在 `cordis.patch.yml` 里配这些字段不会生效（Web 端同样如此）。
- **`inject` 硬要求五个服务**（`slots`/`locale`/`sessions`/`uiSession`/`uiWorkspace`）：
  少一个就整个插件不激活（连开关都没有）。0.2.0-rc.2 五个都在，且已用测试把清单钉住。
- **多窗口**：当前桌面端是单主窗口；去重逻辑天然支持多窗口，但未实测。
- **失败/成功区分、后台 job 完成通知、通知聚合**：与 Web 端一样仍在 Roadmap，未实现。

## License

MIT