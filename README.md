# dsh-diff-review

DSH 内的**文件变更审阅**插件：agent 每改一个文件就进清单，点开看逐行差异，顶部提供**保留 / 撤销**，可按「上一处 / 下一处」在改动之间跳，也能全屏看。

---

## 先说清楚它和 DSH 自带功能的关系

DSH 已经自带两个**只读**的变更观察面（本人已在本机 `dsh-web-app` 的 patch 里确认它们都被挂载）：

| 已有能力 | 位置 | 缺什么 |
|---|---|---|
| 轮尾「已编辑 N 个文件」卡片 + 右侧栏 `changes-review` tab（左右双列、双行号、Shiki 词法高亮） | `@deepseek-ai/dsh-client-ui-deliverables` + `@deepseek-ai/dsh-workspace-changes` | **不能保留 / 撤销**，且要等一轮结束才出现 |

所以本插件**不重造差异渲染**，只补它没有的事：

1. **边改边出清单**——不必等一轮结束，每次 `write` / `edit` 成功立刻出现一条；
2. **点开预览 + 顶部保留/撤销**——带 `i/N` 切换、`Ctrl+Enter` 保留、`Ctrl+Backspace` 撤销；
3. **真正的撤销动作**——把修改前的原文写回磁盘（带版本防护）；
4. **改动之间快速跳转**——「上一处 / 下一处」按差异块（`⋯` 分隔的地方）定位并滚动过去，到两端回绕；
5. **全屏阅读**——面板可一键铺满整个应用窗口，`Esc` 退出全屏、再按一次才关闭面板。

二者并存、互不干扰。

---

## 界面与快捷键

```
┌ 文件变更审阅   3 个待审     [A- 12px A+] [全屏] [全部保留] [全部撤销] [关闭] ┐
├──────────────┬───────────────────────────────────────────────────────────┤
│ a.js  +2 -1  │ a.js  2/5        [第 1/3 处] [上一处] [下一处]  [撤销] [保留] │
│ b.md  +1 -0  │ ───────────────────────────────────────────────────────────│
│ …            │  12  ctx    const x = 1;                                  │
│              │  13  del  - const y = 2;                                  │
│              │  14  add  + const y = 3;                                  │
│              │  15  ctx    const z = 4;      ← 未变更的行也全部显示      │
│              │  16  ctx    export default App;                           │
└──────────────┴───────────────────────────────────────────────────────────┘
```

**默认把整个文件都显示出来**，不再用 `⋯` 省略未变更的部分——审阅时要能一眼看全上下文。
只有文件大到超过引擎的渲染上限（`lib/diff.js` 的 `MAX_DISPLAY_LINES`，默认 4000 行）时，
才会退回「只显示改动附近」，并在差异上方**明确写明**「已折叠未变更部分」（不会悄悄省略）。

**字号可调**：标题栏的 `A-` / `A+` 每次 1px（范围 **10~24px**，默认 12px），中间显示当前值，
到上下限按钮自动置灰。面板内部所有文字都写成 `em`、挂在面板基准字号上，
所以**代码与界面文字一起缩放**（侧栏那个「变更审阅」入口属于应用侧栏，不跟着变）。
选择存在 `localStorage`（键 `dsh-diff-review:font-size`），刷新页面、重启 DSH 都还在；
存储不可用（隐私模式等）时静默退回默认值，不影响使用。

| 操作 | 钩子 |
|---|---|
| 保留当前文件 | `Ctrl+Enter`，或工具条上的「保留」 |
| 撤销当前文件 | `Ctrl+Backspace`，或工具条上的「撤销」 |
| 跳到下一处改动 | `Alt+↓`，或工具条上的「下一处」 |
| 跳到上一处改动 | `Alt+↑`，或工具条上的「上一处」 |
| 放大 / 缩小字号 | `Alt+=` / `Alt+-`，或标题栏的 `A+` / `A-` |
| 全屏 / 退出全屏 | 标题栏的「全屏 / 退出全屏」 |
| 退出全屏 · 关闭面板 | `Esc`（全屏时先退全屏，再按一次才关闭） |

「上一处 / 下一处」跳的是**差异块**：切分依据是**两处改动之间在文件里真实隔了多少行没变更的内容**
（阈值 = 2×上下文行数，6 行）。所以它**和是否折叠无关**——全量模式下一个 `⋯` 都没有，
照样能在「隔 3 行的两处改动」之间当成一处、「隔 30 行的两处」当成两处。
切到某一处时，那一块的行号会变色，写明「第 k/M 处」，并把第一行改动滚到视口上方约 1/3 处。

---

## 它怎么工作

```
agent 调用 write / edit
        │
        ▼
tools/post-execute 瀑布（宿主半，纯观测，不改工具结果）
        │  读 result.value = { path, before, after }   ← 权威全文，零额外 IO、零竞态
        ▼
内存清单（同会话同文件自动合并：留最早的 before、最新的 after）
        │
        ├── GET  /api/dsh-diff-review/state   → 清单（含 +N/-M 摘要，不含正文）
        ├── GET  /api/dsh-diff-review/file    → 单个文件的逐行差异 + 前后全文 + 差异块列表
        └── POST /api/dsh-diff-review/action  → keep / undo / keep-all / undo-all / clear
        │
        ▼
客户端半（浏览器）在左侧栏底部放「变更 N」按钮，点开是审阅面板
```

差异块（`diff.hunks`）由宿主半算好随 `/file` 下发，切分只有一份实现（`lib/diff.js` 的
`diffHunks()`，有单元测试），客户端只负责序号、定位与滚动。

**客户端为什么必须「强制重拉」而不是吃缓存**（实测踩出来的坑）

清单项里的 `added` / `removed` / `kind` 由宿主在**记录/合并的那一刻**算好、随清单下发；
界面刷新时，当前文件的差异一律 `loadFile(id, true)` **强制重拉**。原因是：

- 同一个文件被**第二次编辑**时记录是**合并**的——`before` 不变、`after` 变长，
  **条目 id 没变**，只是 `rev` / `updatedAt` 变了。此时若沿用缓存，面板会继续显示上一轮的
  差异（"少了一块改动"），要手动点一下列表（`select()` 会清缓存）才恢复。实测现象就是
  「对照漏了 → 点一下又对了」。
- 列表行的 `+N/-M` 原先也是从「已拉到的正文」里算的，于是**没点开过的文件根本没有数字**。
  改成宿主下发后，列表数字与展开的差异**同源**，不会再各说各话。

**为什么用 `result.value` 而不是去读文件或挂 `fs/write-intent`**

- `fs/write-intent` / `fs/edit-intent` 是**单槽决策瀑布**，`dsh-fs-observation-policy` 会先注册并直接给出决策、不调用 `next()`；插进去抢槽会破坏它的版本防护语义。所以不碰。
- `write` / `edit` 工具的返回值本身就是 `{ path, before, after }`（DSH 自己的 diff 卡片就是用这份 value 算的），拿它最准、也最省。

**撤销为什么要这么写（四条坑都写在代码注释里）**

1. 先 `stat` 拿当前 version，用 `{ kind: 'replaceIfVersion', version }` 做 CAS；否则会覆盖你审阅期间的新改动（失败码 `FS_STALE_VERSION`，界面会提示重试）。
2. 直接调 `ctx.fs` **不会**经过观察策略，该会话对这条路径的观察状态仍是旧的，模型下一次 `edit` 会 `FS_STALE_VERSION`；所以撤销成功后必须用当初的 `exec` 补发一次 `fs/observed`。
3. `ctx.fs` 没有删除原语：撤销「新建文件」只能退出 `ctx.fs` 用 `node:fs` 删除，**并且先核对内容仍是 agent 写的那一份**，否则宁可失败也不误删你自己的修改。
4. **必须显式传 per-call 沙箱策略**。这条是实机验证时踩出来的：`dsh-fs-sandbox` 的 `checkedTarget()` 在没收到策略时会回落到 `ctx.sandboxPolicy.resolve()`，那是「部署默认模式 + 进程 cwd」，**没有会话工作区根**，于是哪怕文件就在会话工作区里也会被判为越界，撤销对已有文件 100% 失败（`FS_SANDBOX_DENIED`）。现在按官方 `dsh-tool-fs` 的做法，用「产生这条改动的那个会话」解析 `{ mode, workspaceRoot }` 一起传下去。注意这个服务是**可选读取**（`ctx.get`），不能写进 `inject`——用 `dsh-fs-local` 的部署根本没有它。

---

## 安装

包是零依赖的（不需要 pnpm 联网装依赖），用官方 CLI 装进 desktop profile：

```powershell
dsh plugin --profile desktop add E:\dsh-pluges\dsh-diff-review
# 或本地开发用软链：
dsh plugin --profile desktop add link:E:\dsh-pluges\dsh-diff-review
```

卸载：

```powershell
dsh plugin --profile desktop remove dsh-diff-review
```

装完要刷新 GUI 页面（DSH 有 HMR；模块重载后按 F5 让 `lib/client.js` 重新拉一次即可）。**不要手工编辑 profile 的 `cordis.patch.yml`。**

---

## 测试

核心逻辑不依赖 DSH，可以离线验证（40 个用例）：

```powershell
cd E:\dsh-pluges\dsh-diff-review
node test/diff.test.mjs   # 23 个：行级差异引擎 + 全量展示 + 差异块切分（diffHunks）+ 行号不变量
node test/host.test.mjs   # 17 个：捕获 → 清单 → 差异 → 保留 → 撤销（用假 ctx 装配宿主插件）
```

> 注意：沙箱下 `node --test test/` 会因为测试运行器给子进程接管道而 `EPERM`，所以按文件直接跑（进程内）。

另外本机工作区里还有个 `_verify\` 目录（**未纳入仓库**，因为它读本机 DSH 凭据、路径也写死在本机），
里面有三件**实机验证工具**：
`probe.mjs` 用本机已持久化的会话签名密钥自签一个 loopback cookie（密钥处理在
`dsh-auth.mjs`），直接查运行中 Host 的清单/差异/动作路由；`analyze.mjs` 把
**插件捕获的 after** 和**磁盘真实内容**对比，回答「面板是不是漏了改动」；
`client-smoke.mjs` 在 Node 里执行 `lib/client.js` 真实产物（假 React 含
`useRef`/`useLayoutEffect` 等价语义、假 DOM），验证插槽注册、逐行渲染、全屏状态机、
`Esc` 的两段语义、「上一处/下一处」的计数/回绕/滚动定位、字号调整与持久化，
以及**合并更新后是否重拉**。配套的 `make-broken.mjs` 会生成一份把修复回退掉的副本，
用来证明相关用例确实会失败
（测试有牙齿）。用法与历史结论见 `_verify\README.md`。

---

## 实机验证记录（2026-09-30，DSH 0.1.7-rc.2 / Desktop 2.0.15）

装在 `desktop` profile（`dsh plugin --profile desktop add E:\dsh-pluges\dsh-diff-review`，
以 `link:` 形式链接，`dsh.profile.bundles` 由 CLI 自动登记）。

| 项 | 结果 |
|---|---|
| 宿主半加载 | ✅ 无需重启：profile manifest 被 HMR 监听，改完立刻挂载；`/api/dsh-diff-review/state` → 200 |
| 捕获 | ✅ 真实 `write`/`edit` 调用被捕获，sessionId / cwd / 相对路径都正确 |
| 合并 | ✅ 同文件连续改动合成一条（最早 before、最新 after） |
| 差异 | ✅ `ctx/del/add/ctx` + 双行号，`create`/`modify` 分类正确 |
| 客户端半 | ✅ 进入浏览器启动图（71 条），Host 送达 bundle 200/22862 字节 |
| 保留 / 撤销新建文件 | ✅ 保留不动磁盘；撤销新建文件把文件删掉 |
| 撤销写回已有文件 | ✅ 修复后通过（修复前 100% `FS_SANDBOX_DENIED`，见上文陷阱 4） |

**v0.2.0 新增功能**（全屏、差异块导航）的验证方式是离线执行真实客户端产物：
`_verify\client-smoke.mjs` 用假 React + 假 DOM 跑通「点全屏 → `data-fullscreen=true` →
`Esc` 退回全屏 → 再 `Esc` 关面板」，以及「第 1/2 处 → 下一处 → 第 2/2 处 → 回绕」、
`Alt+↓/↑` 钩子、当前块高亮与滚动定位；差异块切分本身由 `test/diff.test.mjs` 的 6 个用例钉住。
真实浏览器里的视觉样式仍建议刷新页面后目测一次。

**v0.2.1 修掉「对照漏了」**：实机上同一个文件被第二次编辑后，面板仍显示上一轮差异；
现在清单 rev 变化一律强制重拉当前文件。回归用例见 `client-smoke.mjs` 的
「同一个文件被再次编辑后不能吃旧缓存」，并用 `make-broken.mjs` 验证过它对着旧代码会失败。

**v0.3.0 改成完整展示**：不再用 `⋯` 省略未变更内容，整个文件都画出来；
超过 `MAX_DISPLAY_LINES`（4000 行）才退回折叠，并在界面上写明「已折叠未变更部分」。
差异块切分同时改成**按真实行距**，因此去掉 `⋯` 之后「上一处/下一处」的块数与全量前一致
（实测那条记录：折叠 137 行 / 7 个 `⋯` / 7 块 → 全量 312 行 / 0 个 `⋯` / **仍然 7 块**）。
另加了一条**行号不变量**用例（a、b 两列必须严格递增），用来挡住「差异错位」这类问题。

**v0.4.0 加字号调整**：标题栏 `A-` / `A+`（`Alt+-` / `Alt+=`），10~24px、默认 12px，
存在 `localStorage` 里；面板 CSS 内部全部改成 `em`，所以一处基准字号就能缩放整个面板。
验证方式见 `_verify/client-smoke.mjs`：默认值、加减、上下限置灰、快捷键、
以及**重新执行一次 bundle（等价刷新页面）读回记住的字号**。

**宿主半的源码改动不会热重载**：DSH 的 HMR 对 profile 配置默认开启，但模块监听是
opt-in（`hmr.config.root: []`）。所以改 `lib/index.js` 之后需要**重启 DSH**（或重启
Desktop 应用）才生效；只改客户端插槽时刷新页面（F5）即可。

---

## 已知限制（都是有意为之或暂未验证）

- **界面仍需 F5 目测一次**：两个插槽名已核对官方声明（`sidebar.footer.action`、`shell.overlay`，都是 `kind: "list"`、`scope: "root"`，所以注册必须带 `id`，本插件带了），客户端 bundle 也已确认进启动图并被 Host 送达 200；但**浏览器里最后那一帧没有自动化验证**——页面是在插件出现之前加载的，客户端模块图新增条目后需要刷新页面（F5）才会挂载。若刷新后仍旧不出现，备选插槽是 `conversation.chat.turnTail`（入口）或注册成右侧栏 tab。
- **shell 命令改的文件抓不到**：只有走 `write` / `edit` 工具的改动才被捕获。`pwsh` / `bash` 里直接写盘的文件不在清单里（官方 `workspace-changes` 用 git 快照能覆盖这类，是它的优势）。
- **清单只在内存**：Host 进程重启后清空（与官方 `workspace-changes` 的既定行为一致）。
- **正文上限 512 KiB / 侧**：超过只留一条「过大」提示，且**不可撤销**（因为没保存原文）。
- **全量展示的上限**：默认整个文件都画，但超过 `MAX_DISPLAY_LINES`（`lib/diff.js`，默认 4000 行）
  会退回「只显示改动附近」并在界面上写明「已折叠未变更部分」。再大就调那个常量，
  但要留意一次渲染上万行会卡（目前没有做虚拟滚动）。
- **大改动退化为整块替换**：两侧行数相乘超过 25 万时不再逐行比较，按整块替换显示并标记 `truncated`（与 DSH 自带 `DiffBlock` 的 `maxEditLength` 退化策略同思路）。
- **只做行级**：不做字符/词级高亮（DSH 全库也没有词级 diff，与现有观感保持一致）。

---

## 文件

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主半：捕获 `tools/post-execute`、内存清单、三个 `/api` 路由、撤销实现 |
| `lib/diff.js` | 行级差异引擎（纯函数，可单测）：LCS + 全量/折叠显示 + 差异块切分 + 大文件退化 |
| `lib/client.js` | 客户端半：手写 factory-CJS bundle（无需打包器），插槽注册 + 审阅面板 |
| `cordis.patch.yml` | 挂载声明 |
| `test/diff.test.mjs`、`test/host.test.mjs` | 离线测试 |
