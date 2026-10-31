# 把 dsh-task-notifier 适配到桌面端 — 变更报告

> 结论：桌面端专用孪生包已创建、构建、离线验证（11+33+6 = 50 项全绿）、接入 desktop profile，
> **并在桌面端重启后实测生效**（Windows 通知数据库里留下了本插件 tag 的真实 toast 记录）。
> Web 端插件与 Web profile **未改动**。
> 后续：曾按反馈改过一版开关样式，**已回退**；用户实际指的"黑雾"经像素取证定位为
> DSH 自带的会话列表 24px 渐隐条，已用一条最小样式覆盖掉（见 §9.2 / §9.3）。

日期：本次会话
范围：`D:\collection_of_projects\dsh`（新建包）+ `D:\DeepseekHome\profiles\desktop`（接线）

---

## 1. 原始状态（改动前）

| 事实 | 证据 |
| --- | --- |
| Web profile 装有并加载通知插件 | `profiles/web/package.json`：依赖 `link:...dsh-task-notifier`，bundles 含 `@dsh-external/dsh-task-notifier` |
| 桌面端 profile **完全没有**通知插件 | `profiles/desktop/package.json`：依赖只有 `dsh-web-search-multi-desktop` + `trisoul_x`，bundles 无 notification 相关项 |
| 桌面端运行时是 0.2.0-rc.2（与 Web 端 0.1.7-alpha.2 不同代） | `resources/runtime/primary-runtime/runtime.json` → `desktopVersion = 0.2.0-rc.2`；`app.asar → dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json` → `0.2.0-rc.2`（后者正是 `getDshRuntimeVersion()` 读的地方） |
| Web 包直接装桌面端会被闸门丢弃 | `^0.1.7-alpha.2` 对 `0.2.0-rc.2` 判定为 false（实测见 `tests/desktop-verify.mjs` 的控制组） |
| 桌面端 profile 已有孪生包先例可循 | `@dsh-external/dsh-web-search-multi-desktop`（同名 pattern、`link:` 安装、`.bak-before-*` 备份） |
| `trisoul_x` 没有通知功能、也不占 `sidebar.footer.action` | 全量 grep：无 `sidebar.footer.action`，无 `Notification` API 调用（命中的都是内部 `notify()` 方法名） |

---

## 2. 交付物

新建包 `D:\collection_of_projects\dsh\dsh-task-notifier-desktop`：

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包身份 / `^0.2.0-rc.2` peer / `dsh.bundle.patch` / `dsh.client.inject` |
| `cordis.patch.yml` | 插入**独立** loader row `task-notifier-desktop` |
| `src/index.ts` | host 半边（no-op row，与 Web 端同构） |
| `src/client/index.ts` | 客户端半边：事件识别 + 焦点门控 + 去重 + 通知投递 + 侧边栏开关 |
| `tsconfig.json` / `tsconfig.client.json` | host（node types）与 client（DOM lib）分别类型检查 |
| `tsdown.config.mjs` | client bundle 构建，banner id = 独立包名 |
| `scripts/profile-wiring.mjs` | `--check` / `--apply` / `--rollback` 接线与回退（含偏离保护） |
| `tests/compatibility.test.mjs` | 11 项行为测试（vm 沙箱），含身份/服务门控/silent/两类 pending kind/开关结构/会话列表 fade 覆盖 |
| `tests/desktop-verify.mjs` | 33 项：闸门 / 身份 / host 半边 / loader row / 接线 / 标识符隔离 / 组合出的 loader rows |
| `tests/isolation.test.mjs` | 6 项：与本机已装插件 + 出厂 app.asar 的冲突扫描 |
| `tests/lib/asar.mjs` | 只读 asar 读取小工具（供上面两套复用） |
| `tests/run-all.mjs` | 跑完全部套件并汇总退出码（避免 `&&` 静默跳过） |
| `README.md` | 设计、隔离矩阵、环境差异依据、构建/安装/回退/排障、实测证据 |

---

## 3. 本机实际改动（仅 desktop profile）

`profiles/desktop/package.json` 两行增量（无删除、无重排既有项）：

```diff
   "dependencies": {
+    "@dsh-external/dsh-task-notifier-desktop": "link:D:/collection_of_projects/dsh/dsh-task-notifier-desktop",
     "@dsh-external/dsh-web-search-multi-desktop": "link:...",
     "trisoul_x": "git+https://github.com/gulagala001/oh-my-dsh.git"
   },
   "dsh": { "profile": { "bundles": [
     ...
-    "@dsh-external/dsh-web-search-multi-desktop"
+    "@dsh-external/dsh-web-search-multi-desktop",
+    "@dsh-external/dsh-task-notifier-desktop"
   ] } }
```

- `pnpm-lock.yaml`：pnpm 自行更新，**只增 3 行，删 0 行**（已用 diff 逐行核对）；
- `node_modules/@dsh-external/dsh-task-notifier-desktop`：pnpm 创建的 link；
- 备份：`package.json.bak-before-task-notifier-desktop`、`pnpm-lock.yaml.bak-before-task-notifier-desktop`。

**未触碰**：

- `profiles/web/*`（Web profile 与 Web 端插件安装）；
- `dsh-task-notifier/`（Web 孪生包整个目录）；
- `profiles/desktop/cordis.patch.yml`（无需 pin：host 半边 no-op）；
- `trisoul_x` / `dsh-web-search-multi-desktop`；
- `D:\DeepSeek Harness\`（Electron 安装目录只读扫描，未写入）。

两点精确说明：Web profile 三个文件的 mtime（`2026-09-23`）远早于本次改动（`2026-10-01`），
Web 孪生包也未被本次改动写过一个字节；但 Web 孪生包**相对它自己的 git HEAD 本来就是 dirty 的**
（一次更早的 0.1.7 迁移留下的 `M README.md, package.json, src/client/index.ts`），
这与本次移植无关，不要误读成"本次动过它"。

### 依赖完整性核查（针对 pnpm 输出 `Packages: -32`）

首次 `pnpm install` 报了 `-32`。核查结论：**是清理游离包，不是删依赖**。

| 核查 | 结果 |
| --- | --- |
| lockfile 差异 | 删 0 行 / 增 3 行 |
| profile 所有 `dsh.profile.bundles` 解析 | 全部 OK（`@deepseek-ai/dsh-experimental-*` 三个由 app.asar 内置提供，本地本就不在） |
| `trisoul_x` 的 13 个直接依赖 | 全部解析 |
| 从 profile 依赖出发的**传递**依赖遍历 | 41 个包，缺失 0 |
| 重复 `pnpm install` | `Already up to date`，`node_modules` 顶层目录 43 → 43，无渐进退化 |

---

## 4. 验证结果

离线三套（`pnpm test` 用 `tests/run-all.mjs` 汇总，任一套失败都不会静默跳过后面的）：

```
tests/compatibility.test.mjs  11 passed, 0 failed
tests/desktop-verify.mjs      33 passed, 0 failed
tests/isolation.test.mjs       6 passed, 0 failed
```

关键断言摘录：

- **闸门**：`0.2.0-rc.2 peer gate accepts the Desktop twin`（3 个 dsh-* peer 全过）；
  控制组 `Web twin rejected by the same gate`（证明隔离是必需而非装饰）；
- **身份**：bundle banner id、loader row id、`dsh.bundle.patch`、`exports["./client"]`、
  lazy CJS factory 协议全部符合 loader 读取方式（YAML 用真实 `yaml` 解析，不是正则糊弄）；
- **隔离**：10 项标识符双向零交叉；desktop profile 不含 Web 包名，web profile 不含 desktop 包名；
- **冲突**：`no other installed Desktop plugin claims this plugin's identifiers`；
  `no other Desktop module-graph row registers the same client bundle id`；
- **出厂客户端**：`the shipped Desktop app contains none of the isolated identifiers`（扫 app.asar）；
- **插槽共存**：`sidebar.footer.action` 在出厂 bundle 里确实是 `kind: "list"`，注册新 entry 不会挤掉已有项；
- **行为**：状态边沿→通知、点击→`openSession` + `window.focus()`、焦点门控、3 秒去重、
  权限被拒时降级为标题闪烁、空白会话标题回落会话 id。

### 回退演练（已实测）

```
node scripts/profile-wiring.mjs --rollback
  → 还原 package.json + lockfile、移除 link、pnpm 重新同步
  → 报告 ROLLED BACK（dependency 缺省 / bundle 未列 / link 不存在）
node scripts/profile-wiring.mjs --apply
  → 复用既有备份（profile 与备份一致时），重新接回 WIRED
```

「回退 → 再接线」闭环已验证通过，且 `--apply` 在 profile 与备份不一致时会**拒绝覆盖备份**（保护回退锚点）。

---

## 5. 桌面端适配了什么（相对 Web 端代码的实质差异）

1. **身份全隔离**：包名 / 版本 / row id / bundle id / locale NS / slot entry id / 设置键 / 去重前缀（见 README 隔离矩阵）；
2. **权限文案与判定**：按 `location.protocol === 'dsh-app:'` 识别桌面 shell，
   文案改为"由桌面应用授予"，不再引导用户去翻浏览器站点设置；
   权限提示改为**渲染时求值**（Web 端在模块加载时求值，改了权限要刷新页面才更新）；
3. **点击聚焦**：抽 `focusShell()`（preload 桥没有 show/restore，`window.focus()` 是唯一 renderer 侧手段，
   Windows 上 toast 点击本身也会激活应用）；
4. **标题回落**：`displayTitle` 可能缺失（空白会话），回落到会话 id，避免弹空标题；
5. **补上 client 半边类型检查**（Web 包的 `typecheck` 从不覆盖浏览器源码）；
6. 其余事件逻辑（信号分类、焦点门控、去重、降级、开关 UI）刻意与 Web 端保持一致。

依据（全部来自出厂 0.2.0-rc.2 产物，非猜测）：

| 事实 | 证据位置 |
| --- | --- |
| `dsh-app://app/` 注册为 `standard + secure` | `main.js:11019-11029`、`main.js:11542-11551` |
| 非 media 权限由 shell 放行 | `main.js:6274-6296` |
| `uiSession` 服务与 `sessionStatus` 形状 | `dsh-client-ui-session/lib/client.js`（`super(ctx, "uiSession")`、字段 `running/pendingInteraction/completionUnread`） |
| `uiWorkspace.openSession` | `dsh-client-ui-workspace/lib/client.js:821` |
| 会话行 `displayTitle` | `dsh-client-ui-workspace/lib/client.js:4210` |
| 关窗=隐藏到托盘（renderer 存活） | `main.js:12028-12038` |
| preload 无窗口 show/restore | `preload-app.cjs:789-842` |

---

## 6. 桌面端运行实测（已完成）

桌面端已重启（`dsh.profile.bundles` 只在启动时读取，没有 live bundle reload），
本包**实际生效并弹出了真实 toast**。只读取证结果：

| 证据来源 | 内容 |
| --- | --- |
| Electron localStorage（`%APPDATA%\@deepseek-ai\dsh-desktop\Local Storage\leveldb`，来源 `__dsh-app://app`） | `dsh-task-notifier-desktop:last:end:session-d1322303-…` = `1790833656022`（13:47:36）、`dsh-task-notifier-desktop:last:end:session-47092752-…` = `1790834842281`（14:07:22） |
| 同一 leveldb 的负对照 | 无任何 `dsh-task-notifier:`（Web 端）键 |
| Windows 通知数据库 `wpndatabase.db` | toast tag = `n#dsh-app://app#end:session-47092752-dfc1-46ea-8ba5-118716bbadca`；`dsh-app://app` 全库出现 2 次，均属本插件 |

**这组证据为什么足够**：去重戳证明客户端半边激活（五个 `inject` 服务全部就绪）、
watcher 运行并识别出"选中会话 running→idle"边沿、`sessionTitleOf()` 拿到了会话标题；
而通知数据库里的 `n#dsh-app://app#end:<sessionId>` 记录证明**焦点门控放行并且 Windows 真的显示了 toast**
（门控若拦截，localStorage 仍会留戳，但通知库不会有记录——两边都有才算数）。

复现：`node .recon/live-notification-evidence.mjs`（工作区根目录，只读）。

仍未实测的部分（已在 README §10 写明，不当作已验证）：

- `document.hasFocus()` 在**托盘隐藏那一瞬**的取值（已实测"未聚焦→放行"，但未观测那一刻的窗口状态）；
- `done:`（非选中会话完成）与 `pending:`（提问/审批/计划评审）两类 toast 的真实弹出——
  当前库里只有 `end:` 记录，它们的 API 形状是静态验证的；
- 通知点击的行为（无法自动点击 toast）；
- 多窗口去重。

---

## 7. 独立评审与据此的修正

交付前做过一轮独立对抗式评审（只读、不碰文件）。评审确认了隔离、冲突、部署可回退与客户端 API 形状，
并指出以下问题，**已全部修正**：

| 评审发现 | 修正 |
| --- | --- |
| 客户端服务门控（`inject` 五个服务）**没有任何测试**：把 `uiSession` 改名，全部检查照样全过，而真机上插件会静默不激活 | `compatibility.test.mjs` 新增 `plugin.name` / `plugin.inject` 断言（跨 realm 用 host 数组比较） |
| `npm test` 用 `A && B && C`：前一套失败会**静默跳过**后一套，"隔离测试没跑"与"隔离测试失败"无法区分 | 新增 `tests/run-all.mjs`，跑完全部三套并汇总退出码 |
| `sound: false` 仍会响（系统提示音不受控），`sound: true` 会"系统音 + 蜂鸣"双响 | `sound` 映射到 toast 的 `silent`；WebAudio 蜂鸣只在退回标题闪烁时使用；新增 `silent` 断言 |
| 点击 toast 无法把托盘隐藏的窗口叫回来，而原注释声称"OS 会激活应用" | 修正注释与文档为**明确限制**，不再声称可恢复托盘窗口 |
| 只有 `question` 分支有测试，`approval` / `plan-review` 无覆盖 | 新增两类 kind 的文案与 tag 断言 |
| "requires only declared externals" 只断言某个字符串**不存在**，空 bundle 也能过 | 改为枚举 bundle 里所有 `require("…")` 并断言集合 ⊆ {react}，且非空 |
| "sidebar.footer.action 是 list 槽"只取首次出现后 160 字符，是子串匹配 | 改为匹配声明条目本身 `key: "sidebar.footer.action", kind: "list"` |
| peer 版本写死 `0.2.0-rc.2`，桌面端升级后会拿旧版本对比 | 改为读 `app.asar → @deepseek-ai/dsh-app-boot/package.json`（即 `getDshRuntimeVersion()` 的同一处），并打印来源 |
| `--rollback` 无条件覆盖，会**静默销毁** `--apply` 之后的改动；且失败时仍 `exit 0` | 新增偏离保护（已接线时的正常回退放行，其他情况拒绝）；`STILL WIRED` 时返回非 0 |
| 文档计数漂移（写 30 项）、错误的 runtime 版本引用路径 | 已改为实际计数与可复现的证据路径 |

评审同时把 `snapshot.current`（0.2.0-rc.2 的会话列表快照里不存在该字段）与 `displayTitle` 兜底
认定为**死代码**——它们与 Web 端同构、无害且与内置 `ui-workspace` 的写法一致，故保留并在此记录。
去重戳写在焦点门控之前、`pending` tag 不含 `interaction.key` 这两处是**继承自 Web 端的行为**，
本包刻意不单方面改变，已写入 README §10 的已知怪癖。

## 8. 回退手册

```bash
cd D:\collection_of_projects\dsh\dsh-task-notifier-desktop
node scripts/profile-wiring.mjs --check      # 先看状态
node scripts/profile-wiring.mjs --rollback   # 还原 package.json + lockfile，移除 link
```

回退后**重启桌面端**即回到改动前状态。备份文件保留在
`D:\DeepseekHome\profiles\desktop\*.bak-before-task-notifier-desktop`，可人工比对。
Web 端从始至终未改，无需回退。

## 9. 侧边栏开关的视觉改动（**已回退**）

> **状态：已回退。** 下面保留当时的改法与排查过程作为记录；
> 源码与 `lib/client.js` 的开关样式都已回到改动前（`color: inherit` + 1px 边框 + 透明底），
> 全量测试 **50 项全绿**（11 + 33 + 6，其中 +1 项是 §9.3 的 fade 覆盖测试）。回退后的实测见 §9.2。

### 9.1 当时（后被证伪）的判断

反馈：截图里"通知已开"在暗色主题下是一块**黑字 + 灰色硬边框**，很难看，要求淡化/透明。

根因两条，都可验证：

1. `color: 'inherit'`：footer 上下文继承到的是深色文字色，暗色主题下渲染成黑字；
2. `border: 1px solid var(--dsw-alias-border, rgba(127,127,127,0.25))`：把 0.2.0-rc.2 前端产物里的
   CSS 变量全量导出后共 **104 个 `--dsw-*` token，其中没有 `--dsw-alias-border`**
   （只有 `--dsw-alias-border-l1…l4`），所以这条边框一直回落到那个可见的灰色 fallback。

改法（**只改桌面端这一份**，Web 孪生包未动）：

| 属性 | 改后 |
| --- | --- |
| 边框 | 去掉 |
| 背景 | 透明（悬停才给 `--dsw-alias-interactive-bg-hover`，回落 12% 灰） |
| 文字色 | `var(--dsw-alias-label-tertiary, rgba(140,140,140,.85))`，不再 `inherit` |
| 整体 | 静止 `opacity: .75`，悬停恢复到 1 |
| 开/关字 | `--dsw-alias-state-success-primary` / `--dsw-alias-state-error-primary`，是全控件唯一的饱和像素 |

验证与证据：

- 新增**渲染型**回归测试（最小 React stub 把组件渲染成普通对象后断言样式与开/关语义）；
  compatibility 由 10 项变 11 项，全量 **50 项**仍全绿；
- bundle 标记核对：无 `color: "inherit"`、`border: "none"`、四个主题 token 均在、旧的无意义 token 已消失。

生效方式：client bundle 是页面加载时取的，**刷新桌面端 renderer** 即可
（打包版 `devTools: true` 且 F12 已绑定加速键：F12 → Ctrl+R）；不想刷新就重启桌面端。

> 注：仓库 `.gitignore` 忽略 `lib/`，而 profile 用 `link:` 指向本目录，
> 所以**改完必须 `pnpm run build:client`**，否则真机仍读旧 bundle。

### 9.2 回退后的实测与更正

用 DPI 感知的 `PrintWindow` 抓了桌面端真实窗口（`.recon/capture-window.ps1`，
第一次抓到的 1168×862 是 DPI 虚拟化后的**裁切**结果，真实窗口 1752×1293）：

| 观测点 | 实测 |
| --- | --- |
| 桌面端 footer 结构 | `footArea` → `footerActions`（本插件开关 + `未分组新对话` 并排）→ `settingsArea`（设置） |
| 开关外观 | 浅色 1px 边框 + 8px 圆角 + **白字** + 绿色 `开`（在蓝灰侧边栏上清楚可读） |
| 开关正上方 60px 的像素 | 恒为 `(59,73,94)` 均匀底色，**没有任何渐变/黑雾** |
| footer 两个容器的 CSS | `footArea` / `footerActions` **无** background / gradient / box-shadow（从出厂 bundle 的 CSS 字符串读出） |

因此当时的改法**没有解决用户指出的现象**，遂回退。

侧边栏底部附近**唯一**存在的渐变来自出厂 `@deepseek-ai/dsh-client-ui-workspace`：

```css
._9lTDKa_fade { height:24px; position:absolute; bottom:0; pointer-events:none;
  right:var(--dsh-session-list-edge-inset);
  background:linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill)); }
```

它渐隐到**侧边栏自己的底色**（`--dsw-specific-sidebar-fill`），所以在纯色主题下不可见，
只在会话列表内容滚到它下面时起遮罩作用；这是宿主 chrome，不是本插件绘制的。

用户截图里同时出现了「深色背景 + 黑色文字」——而桌面端实测是「蓝灰背景 + 白字」，
两者不一致，于是先向用户确认了截图来源（避免第二次改错）。

### 9.3 定位到真正的黑雾并修掉

用户确认截图来自桌面端，并补发了一张完整窗口截图：**Oh My DSH 主题**（半透明侧边栏 + 壁纸）。
对那张图做像素剖面（x=200，从会话行往下）：

```
y=1056..1062  (90,82,79)   侧边栏底色
y=1068        (79,73,69)   ← 开始变暗
y=1074        (70,63,60)
y=1080        (59,54,50)
y=1086        (49,45,42)
y=1092        (38,35,33)
y=1098        (28,27,24)   ← 渐隐到近乎纯黑
y=1104        (91,82,79)   ← 在 footer 上边缘**突然**跳回底色
```

一段平滑变暗、并在 footer 边界处**硬切**的带子：按 1.5× DPI 换算 ≈ 36 图像像素，
正好是那条 24px 的 `._9lTDKa_fade`（`position:absolute; bottom:0`，位于会话列表底部 = footer 正上方）。
纯色主题下它渐隐到 `--dsw-specific-sidebar-fill`（= 侧边栏自身底色）所以看不见；
Oh My DSH 把侧边栏做成半透明/壁纸，而该变量仍是深色，于是它显示成一道黑雾。

修法（**只改桌面端这一份**，Web 孪生包未动）：插件注入一条样式并随 fiber 移除

```css
[class$="_fade"] { display: none !important }
```

选择器安全性：CSS Modules 生成 `<hash>_<localName>`；会话列表那条的 local name 是 `fade`
（出厂 bundle `WorkspaceBrowser_module_css_default.fade`，单 class），
而聊天记录的上下渐隐是 `fadeTop` / `fadeBottom`、附件动画是 `fade-in`，
**只有列表那条以 `_fade` 结尾**。该元素是 `position:absolute`，隐藏它不改变布局。
将来 DSH 改类名只会让规则失配（黑雾复原），不会误伤别的 UI。

新增回归测试断言注入标签、选择器形状、随 dispose 移除，并断言选择器**不**匹配
`fadeTop`/`fadeBottom`/`fade-in`；全量测试 **50 项全绿**（11 + 33 + 6）。
生效仍需刷新桌面端 renderer（F12 → Ctrl+R）或重启。

> 更"正统"的修法在主题侧：让 Oh My DSH 把 `--dsw-specific-sidebar-fill` 与其半透明侧边栏对齐，
> 这样连列表的渐隐遮罩都能保留。本插件的覆盖是用户明确要求下的最小改动，删掉一个函数 + 一行
> `ctx.effect` 即可恢复宿主原样。