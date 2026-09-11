调研截至 **2026-09-11**。我把“OpenAI 官方明确写明”“官方源码可直接确认”“社区实测”“工程推断”分开；没有可靠依据的地方直接写“未找到”。

有一个对 **Codex As Subagent** 很重要的先行结论：**不要把“ChatGPT.app 内嵌 CLI”当成天然首选 runtime。**它确实是真正完整的 `codex` 二进制，但它跟随桌面 App 更新，历史上还经常是 `alpha` 构建；对于依赖 app-server wire schema 的第三方集成，**可控、可 pin 的官方 standalone CLI 更适合作为长期稳定 runtime**。另外，我这轮发现一个会修正我们之前设计的点：**当前 `codex app-server` 并没有可靠、正式支持 `--profile` 选择 named profile**，所以不能把 `codex --profile codex-as-subagent app-server` 当既定方案。([GitHub][1])

---

## 1. macOS 上目前有哪些官方 Codex 安装形态？默认路径是什么？

**结论：官方目前明确支持四种“CLI 获得方式”，另外还有桌面 App 和 IDE 这种会自行携带/获取 Codex runtime 的产品形态。**

| 形态                              | 当前官方状态                      | macOS 上可执行文件路径                                                                                                                            | 置信度                               |
| ------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **OpenAI standalone installer** | README 当前首先推荐               | 默认入口 **`$HOME/.local/bin/codex`**；managed binary 当前布局在 **`$CODEX_HOME/packages/standalone/current/bin/codex`**，`CODEX_HOME` 默认 `~/.codex` | **官方明确**                          |
| **npm `@openai/codex`**         | 官方支持                        | **没有统一绝对路径**；位于当前 npm global prefix 的 `bin/codex`，受 nvm/fnm/Volta/npm prefix 等影响                                                          | **官方明确安装方式；路径由 npm 决定**           |
| **Homebrew Cask `codex`**       | 官方 README 支持                | `$HOMEBREW_PREFIX/bin/codex`；Apple Silicon 常见为 `/opt/homebrew/bin/codex`，Intel 常见为 `/usr/local/bin/codex`                                 | **官方安装方式 + Homebrew 明确 artifact** |
| **GitHub Release 手动二进制**        | 官方支持                        | **没有默认路径**，用户解压到哪里就是哪里                                                                                                                    | **官方明确**                          |
| **ChatGPT.app 内嵌 Codex CLI**    | 当前官方桌面产品包含 Codex            | 实测为 `/Applications/ChatGPT.app/Contents/Resources/codex`                                                                                  | **社区实测（很高）**                      |
| **旧 Codex.app 内嵌 CLI**          | 历史官方产品；正在/已经迁移至 ChatGPT.app | `/Applications/Codex.app/Contents/Resources/codex`                                                                                        | **OpenAI 员工确认 + 大量实测**            |
| **Codex IDE Extension**         | 官方产品                        | 内部可以 bundle/fetch runtime，但**未找到官方承诺的稳定绝对 CLI 路径**                                                                                        | **官方明确存在；路径未找到**                  |

OpenAI 当前 README 的 CLI Quickstart 首先给出的其实已经不是 npm，而是 standalone installer：

`curl -fsSL https://chatgpt.com/codex/install.sh | sh`

同时继续明确支持 npm、`brew install --cask codex` 和直接下载 GitHub Release。

standalone installer 源码直接定义：

```text
BIN_DIR = $HOME/.local/bin          # 可由 CODEX_INSTALL_DIR 覆盖
BIN_PATH = $BIN_DIR/codex

CODEX_HOME = ~/.codex              # 可覆盖
STANDALONE_ROOT = $CODEX_HOME/packages/standalone
```

Homebrew 当前 Cask 明确把 `bin/codex` 链接到 `$HOMEBREW_PREFIX/bin/codex`；截至今天版本是 0.154.0。([Homebrew Formulae][2])

**对自动发现实现的含义：不要硬编码 npm 路径。**首先做 `command -v codex` / PATH discovery，再针对 standalone/Homebrew/App bundle 做已知位置扫描。

---

## 2. 现在到底还有没有独立的 `Codex.app`？

**结论：有过，而且是 OpenAI 正式产品；但当前官方桌面产品已经迁移到统一的 `ChatGPT.app`。**

OpenAI 在 **2026-02-02** 正式发布独立 Codex macOS App。([OpenAI][3])

但当前帮助中心已经明确说明：

> 已经使用 Codex App 的用户，“像往常一样更新 Codex App”；更新后它会变成新的 ChatGPT desktop app，其中包括 Chat、Work 和 Codex。

也就是说，**当前官方目标形态不是同时维护两个独立产品，而是统一 ChatGPT desktop app**。([OpenAI Help Center][4])

Homebrew 也已经把：

```text
codex-app
```

标记为 deprecated，并明确推荐：

```text
chatgpt
```

替代；旧 Cask 的 artifact 是 `/Applications/Codex.app`。([Homebrew Formulae][5])

当前 ChatGPT Cask 的 artifact 是：

```text
/Applications/ChatGPT.app
```

且标记 `auto-updates`。([Homebrew Formulae][6])

内嵌 CLI 路径：

```text
旧：
/Applications/Codex.app/Contents/Resources/codex

当前：
/Applications/ChatGPT.app/Contents/Resources/codex
```

旧路径得到了 OpenAI 员工明确讨论：OpenAI 工程师说明 App 里包含一个“**与该版本 App 专门测试过的 bundled CLI**”，并明确不建议把它替换成自己别处安装的 CLI。([GitHub][7])

当前 ChatGPT.app 路径则有大量 2026 年 8–9 月官方仓库 issue 日志直接显示 Desktop 启动：

```text
/Applications/ChatGPT.app/Contents/Resources/codex
    -c features.code_mode_host=true
    app-server
```

([GitHub][8])

**置信度：**

* 独立 Codex.app 历史存在：**官方明确**
* 当前迁移到 ChatGPT.app：**官方明确**
* 两个 bundle 内 `Contents/Resources/codex` 路径：旧版 **OpenAI 员工确认/社区实测很高**；新版 **官方仓库日志实测很高，但未找到 OpenAI 把该文件路径承诺为公共 API**

因此 Codex As Subagent 可以探测这个路径，但**不能把它视为永久稳定的安装 ABI**。

---

## 3. App 内嵌 CLI 会不会随 App 更新？npm/brew 会不会自动更新？

### ChatGPT.app / 旧 Codex.app

**结论：App 更新可以带着 bundled CLI 一起变化，这是高置信度推断，但我没有找到 OpenAI 对“一次 App 更新一定更新 CLI”的正式承诺。**

OpenAI 员工明确说 bundled CLI 是**专门与该版本 App 一起测试的版本**。([GitHub][7])

实际 issue 也不断出现：

```text
Desktop version A → bundled codex-cli X
Desktop update B → bundled codex-cli Y
```

例如近期 ChatGPT Desktop 的 bundle 内出现 `0.147.0-alpha.6.5`、`0.150.0-alpha.8` 等版本。([GitHub][9])

而 ChatGPT Desktop 本身存在自动更新机制；当前 Help Center 甚至提示用户即使“刚刚通过 automatic update notification 更新过”，仍可以手动 Check for Updates。([OpenAI Help Center][10])

**置信度：高置信度推断 + 大量社区实测。**

### npm / Homebrew CLI

**结论：普通 npm/Homebrew CLI 当前默认不是“Codex 自己后台静默升级”。**

Codex 有：

```toml
check_for_update_on_startup = true
```

但当前官方仓库的 feature request 明确说明它只是：

> 检查并展示更新 UI，并不会持续自动安装更新。

自动安装至今仍是请求中的功能。([GitHub][11])

所以：

```text
npm installation
→ npm / 用户 / codex update 等负责实际升级

Homebrew installation
→ brew upgrade / 用户的 Homebrew automation 负责升级
```

而不是 Codex 每次启动无条件替换二进制。

### 一个重要例外：官方 standalone managed install

新的 standalone + `app-server daemon` 有独立 updater。

如果安装的是：

```text
latest channel
+
daemon automatic updater enabled
```

官方 daemon 可以在后台更新 managed binary；默认先等 5 分钟，此后按小时检查。

而：

```text
install.sh --release X.Y.Z
```

这种显式 release selection 是 **pinned** 的，不进入 latest-channel 自动更新。

这对你的项目非常有价值。

---

# 二、认证与配置共享

## 4. 所有安装形态是否共用 `~/.codex/`？App 登录后 CLI 是否无需再登录？

**结论：默认情况下，使用同一个 `CODEX_HOME` 的本地 Codex surfaces 共用认证和配置基础；OpenAI 官方明确设计了登录缓存复用。但不要假设认证一定物理存在于 `auth.json`。**

官方认证文档明确写：

> 当你在 ChatGPT desktop app、Codex CLI 或 IDE extension 使用 ChatGPT 或 API key 登录时，登录信息会被 cached and reused。

并明确说 CLI 和 extension 使用相同 cached login details。([OpenAI Developers][12])

默认：

```text
CODEX_HOME = ~/.codex
```

如果使用 file credential storage：

```text
~/.codex/auth.json
```

但当前还支持：

```text
file
keyring
auto
ephemeral
```

所以“大家一定读取同一个 auth.json”是不准确的。macOS 上可能使用系统 credential store。([OpenAI Developers][12])

因此：

**ChatGPT Desktop 登录 → CLI 无需再登录：官方设计上是的，只要二者使用同一个 Codex auth context，并且存在有效 cached credentials。**

**CLI 登录 → Desktop：官方文档总体也支持本地登录缓存复用；但我没有找到一句逐字写着“CLI 登录保证 Desktop UI 自动进入登录态”的单向保证。**因此我会标记：

**置信度：官方明确共享登录 cache；双向具体 UI 行为为高置信度推断。**

### Sessions

官方源码明确把 rollout/session 数据放在：

```text
$CODEX_HOME/sessions
$CODEX_HOME/archived_sessions
```

并从这些目录构建 thread storage/index。

但：

> **共用底层 session storage ≠ 所有 surface 的 UI 一定实时、完美显示彼此创建的全部 thread。**

桌面 UI 有自己的索引/cache/runtime state，历史上也出现过共享目录下 thread 可见性不同步的问题。

所以 Codex As Subagent 应依赖：

```text
app-server thread/list/read
+
Codex persisted history
```

而不要依赖 Desktop UI 是否正好显示该 thread。

---

## 5. `config.toml` 是否对 App 内嵌运行时和独立 CLI 同样生效？

**结论：基础 `config.toml` 是跨本地 Codex surface 的共享配置基础；但并非每一个字段在每个 surface 上都有完全相同的 UI/生命周期语义，尤其是 named profile。**

官方文档和源码明确把本地 Codex 配置集中在：

```text
$CODEX_HOME/config.toml
```

而当前 config schema 甚至明确有：

```text
desktop
```

这一类 app-specific opaque settings，说明共享配置文件中也可以存在 surface-specific 配置。([GitHub][13])

基础的：

```text
model
sandbox / permission
approval
MCP
features
```

均属于同一个 Codex config stack；当前 Desktop 启动时也确实读取共享 `~/.codex/config.toml`，甚至有 Desktop 修改该文件中 bundled MCP 配置的实测。([GitHub][14])

### 但 named profile 有一个关键限制

这一点对我们之前的 Codex As Subagent 设计非常重要。

当前公开 issue 明确指出：

```text
codex app-server
```

**不接受 `--profile`**，Desktop 也没有正式支持的 profile selection 入口。该 enhancement request 截至 2026-08 仍在请求加入，例如：

```text
CODEX_CONFIG_PROFILE=work
```

这样的能力。([GitHub][1])

早一些的版本里虽然有人使用：

```text
codex -p codex_lb app-server
```

启动成功，但 `thread/start` 实际又没有正确采用 profile 里的 `model_provider`。([GitHub][15])

因此：

> **不能认为 CLI 的 named profile 选择语义和 app-server/Desktop 当前完全一致。**

**置信度：**

* 基础 `config.toml` 共用：**官方明确/官方源码明确**
* model/sandbox/approval 等基础配置参与 app-server/Desktop 配置解析：**官方明确**
* named profile 可以直接用于 `app-server`：**否；当前证据明确表明不能依赖**
* surface 私有状态存在：**官方源码明确**，例如 `desktop.*`，另外 Electron/UI cache 自然也不属于 CLI runtime state

### 对 Codex As Subagent 的直接修正

之前设计的：

```text
codex --profile codex-as-subagent app-server
```

**不能作为 V1 前提。**

更稳的是：

```text
base Codex config
+
app-server/thread-start 显式 model/effort 等 override
```

或者对所选 binary 做 capability probe 后再决定是否使用 profile。

---

## 6. 多种安装形态同时存在，会不会冲突？有没有 singleton/lock 限制？

**结论：没有找到“整台机器只能有一个 Codex/app-server”的官方限制；真正已知的问题是版本选择歧义、共享 CODEX_HOME 状态，以及 managed daemon 的单实例生命周期管理。**

OpenAI standalone installer 自己会检测其他安装，并警告：

> 多个 managed Codex install 会产生歧义，因为究竟运行哪个由 PATH 顺序决定。

这是非常明确的官方信号：**多个安装可以共存，但 binary resolution 需要你自己明确。**

managed app-server daemon 则有明确的 per-`CODEX_HOME` 生命周期状态：

```text
$CODEX_HOME/app-server-daemon/
  settings.json
  app-server.pid
  app-server-updater.pid
  daemon.lock
```

并且所有 mutation lifecycle command：

```text
start
restart
stop
bootstrap
enable/disable remote-control
```

会在同一 `CODEX_HOME` 下串行化。

但是对于普通：

```text
codex app-server --stdio
```

**未找到官方文档规定全局 singleton。**第三方 App 可以启动自己的 child app-server；事实上 OpenAI 自己的 App Server 集成文章就是这样描述 local apps/IDEs 的。([OpenAI][16])

### 实际已知风险

社区已经有真实的版本 skew：

```text
ChatGPT Desktop bundled CLI = 新版本
managed daemon = 老版本
```

导致 initialize handshake 直接超时。([GitHub][17])

也有当前 thread writer ownership 冲突：

```text
Desktop
Remote Control
CLI
```

同时试图继续同一个 thread 时出现：

```text
already has an active writer
```

([GitHub][9])

因此我的工程判断是：

> **可以同时存在多个 Codex binary / app-server，但 Codex As Subagent 必须坚持“一个 active thread 只有一个 runtime owner”。**

这和我们之前设计完全一致。

**置信度：官方明确部分 + 社区实测；“每个 thread 单一 writer”是工程建议。**

---

# 三、app-server 协议与版本

## 7. JSON-RPC 协议有没有稳定性承诺或版本协商？发生过 breaking change 吗？

**结论：OpenAI 明确区分 stable surface 和 experimental surface，但我没有找到类似 MCP `protocolVersion` 的 wire-version negotiation，也没有找到“stable surface 跨 CLI 版本永久向后兼容”的正式承诺。**

app-server 当前协议是：

> JSON-RPC 2.0 风格，不过 wire 上省略 `"jsonrpc":"2.0"` 字段。

初始化必须每条连接执行一次：

```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": {
      "name": "...",
      "version": "..."
    }
  }
}
```

这里返回 platform/runtime 信息，但没有一个双方协商的：

```text
protocolVersion: 2026-xx-xx
```

字段。([GitHub][18])

因此：

**正式 protocol-version negotiation：未找到。**

官方提供的是另一层兼容策略：

```text
默认：
stable surface

capabilities.experimentalApi = true：
experimental surface
```

而 experimental API 被官方明确描述为：

> **no backwards-compatible guarantees**

([GitHub][18])

### wire / behavior 演进的真实例子

一个很明显的 API 生命周期变化是：

```text
thread/rollback
```

现在已经标记 deprecated、计划移除。([GitHub][18])

另一个是 history：

```text
thread/read(includeTurns=true)
```

对于新的 paginated thread 已经不再支持，而新的：

```text
thread/turns/list
thread/items/list
```

承担分页持久历史读取。([GitHub][18])

还有非常近期的实际行为回归：

```text
0.150.1:
thread/start 创建的 zero-turn thread 可 resume

0.151.0:
直到第一 turn 前没有 rollout，
因此同一工作流 resume 失败
```

这是 2026-09-01 报告的明确版本行为变化。([GitHub][19])

还出现过文档和实际 wire method 不一致：

```text
README: tool/requestUserInput
实际: item/tool/requestUserInput
```

([GitHub][20])

所以对于 Codex As Subagent：

> **不能只做 `version >= X` 判断然后假设 API 不再变化。**

应该做 runtime capability/schema probe。

**置信度：官方明确 + 官方仓库实测。**

---

## 8. `generate-json-schema` 是否是当前 binary 的完整权威协议描述？

**结论：对于“该 binary 当前导出的结构化 wire types”，是官方提供的、版本精确匹配的权威来源；但它不是完整的行为语义规范。**

官方 App Server 文档明确写：

> 每次生成的 TypeScript / JSON Schema 都 specific to the Codex version you ran，生成结果和那个版本**精确匹配**。

([OpenAI Developers][21])

默认：

```bash
codex app-server generate-json-schema --out DIR
```

只生成 **stable surface**。

如果要包含 experimental：

```bash
codex app-server generate-json-schema --out DIR --experimental
```

([GitHub][18])

OpenAI 自己关于 App Server 架构的文章还直接建议第三方：

> TypeScript 可以 generate-ts；其他语言可以 generate-json-schema，再喂给代码生成器。

([OpenAI][16])

所以：

**“OpenAI 是否把它作为第三方集成方式？”——是，官方明确。**

但“完整权威协议描述”需要拆开：

| 内容                                        | Schema 能否权威描述 |
| ----------------------------------------- | ------------: |
| request/response/notification 结构          |         **是** |
| stable/experimental 字段集合                  |         **是** |
| enum / required / optional / object shape |         **是** |
| event 顺序                                  |             否 |
| 什么情况下 thread 真正持久化                        |             否 |
| disconnect / retry 语义                     |             否 |
| turn ownership                            |             否 |
| notification timing                       |             否 |
| 跨版本行为兼容性                                  |             否 |

因此你的项目最稳策略应该是：

```text
selected binary
↓
--version
↓
generate-json-schema
↓
验证所需 methods/types
↓
实际 initialize smoke test
```

而不是在仓库里手写一份永久 app-server schema。

**置信度：官方明确。**

---

## 9. `codex app-server daemon` 是什么？桌面 App 会不会常驻一个？第三方应该 attach 还是自己 spawn？

这里现在有非常明确的新信息。

### daemon 的官方定位

官方源码 README 开头直接写：

> `codex-app-server-daemon` is **experimental** and its lifecycle contract may change.

它用于：

> machine-readable `codex app-server` lifecycle commands，被 desktop/mobile 等 remote clients 使用，尤其用于 SSH/远程 Codex instance。

它支持：

```text
codex app-server daemon start
restart
update
enable-remote-control
disable-remote-control
stop
version
bootstrap
```

并可将 app-server 作为 detached PID-backed process 运行。

### Desktop 是否总有这个 daemon？

**否，不能这样假设。**

近期 ChatGPT Desktop 实际日志显示普通本地运行会直接 spawn：

```text
/Applications/ChatGPT.app/Contents/Resources/codex
    ... app-server
```

而且 transport 是 stdio。([GitHub][8])

另一方面，在启用了 remote-control / managed daemon 的机器上，bundled CLI 又可能连接：

```text
~/.codex/app-server-control/app-server-control.sock
```

甚至出现 bundled CLI 与 standalone daemon 版本不一致导致 Desktop 启动失败。([GitHub][17])

所以真实架构是：

```text
普通 Desktop local runtime
→ 可以自己 spawn bundled app-server

managed / remote-control flow
→ 可以连接共享 daemon
```

不能假设“只要 ChatGPT.app 开着，就必有一个可供第三方使用的公共 app-server daemon”。

### 第三方程序该怎么做？

OpenAI 官方架构文章说得很清楚：

> Local clients typically bundle or fetch a platform-specific App Server binary, **launch it as a long-running child process**, and keep bidirectional stdio open.

([OpenAI][16])

因此对于 **Codex As Subagent V1**，我建议：

> **选定一个 Codex executable，然后启动自己拥有的 `codex app-server` 子进程。不要 attach ChatGPT Desktop 正在使用的实例。**

原因包括：

* daemon lifecycle 官方还标 experimental；
* Desktop runtime 可能不是 daemon；
* Desktop 会重启自己的 child；
* 多 writer/thread ownership 会复杂很多；
* daemon binary 甚至可能与当前 bundled CLI 不同版本。

**置信度：**

* daemon 定位：**官方明确**
* Desktop 普通运行会 spawn bundled app-server：**社区实测非常高**
* 第三方应该自己 spawn：**官方架构模式 + 工程建议，高置信度**
* “OpenAI 明文禁止第三方 attach Desktop daemon”：**未找到**

---

# 四、默认选择策略

## 10. 多个 Codex CLI 共存时，官方有没有推荐程序化集成选哪个？

**官方排名：未找到。**

我没有找到 OpenAI 文档说：

> “若 Homebrew、npm、Desktop bundled CLI 都存在，应优先选 X。”

但有足够官方信息可以推导出比较可靠的工程策略。

认证不是主要区别，因为默认相同 `CODEX_HOME`/credential cache 可以复用。

真正区别是：

```text
协议版本可控性
更新行为
是否稳定 release
runtime 完整性
```

### App-bundled CLI 的优点

OpenAI 工程师明确说它：

> tested specifically with that version of the app.

([GitHub][7])

所以它非常适合**给 Desktop 自己使用**。

但这不等于它最适合第三方 integration。

社区中桌面 bundle 多次出现：

```text
0.108.0-alpha.*
0.126.0-alpha.*
0.147.0-alpha.*
0.150.0-alpha.*
```

而同时独立 CLI 是 stable release。([GitHub][22])

而且 Desktop 更新会把 bundled runtime 一起改变。

### standalone installer 的优势

官方 standalone 支持：

```bash
--release X.Y.Z
```

可以显式 pin。

同时它使用完整 managed package layout，而不是你自己随便复制一个 Mach-O binary。

这对 wire-schema-dependent 项目非常理想。

### 不要单纯选“版本号最大的”

这点尤其重要。

例如：

```text
App:
0.150.0-alpha.8

Homebrew:
0.149.x stable
```

不能因为 `0.150 > 0.149` 就默认 alpha 更合适。

正确问题是：

```text
这个 binary 是否提供我们要求的 stable app-server surface？
```

所以 discovery 之后必须做 capability probe。

建议最低探测：

```text
realpath(binary)

binary --version

binary app-server generate-json-schema --out <tmp>
↓
检查必需 method/type

spawn ephemeral app-server
↓
initialize
↓
initialized
↓
model/list 或 harmless capability call
↓
terminate
```

还应该计算：

```text
schema fingerprint
```

记录：

```text
selected executable
codex version
stable schema hash
```

Server 启动后**本次生命周期内绝不自动换 binary**。

---

## 11. ChatGPT.app 自动升级导致 bundled CLI 变化，会带来什么？能否查询/锁定？

**结论：可以可靠查询当前 bundled CLI 版本；未找到官方方式单独 pin ChatGPT.app 内部 Codex CLI。**

查询非常直接：

```bash
/Applications/ChatGPT.app/Contents/Resources/codex --version
```

大量当前 issue 都用这条命令直接诊断 bundled runtime。([GitHub][9])

你的机器得到：

```text
0.153.4
```

正适合在 runtime discovery 中直接采集。

### App 更新的影响

由于：

```text
ChatGPT.app
└── Contents/Resources/codex
```

是 bundle 内资源，App 更新可以替换它。

这意味着：

```text
昨天：
schema hash A

App 自动更新

今天：
相同绝对路径
schema hash B
```

这是**最危险的一种 discovery 方式**：路径完全没变，但协议实现变了。

所以不能把：

```text
/Applications/ChatGPT.app/Contents/Resources/codex
```

当作“固定版本 runtime”。

应该每次 Codex As Subagent Runtime Server 冷启动时至少重新获取：

```text
mtime / inode（可选）
--version
schema hash
```

而不是长期缓存：

```text
这个路径验证过一次，所以永远兼容
```

### 能不能锁定 embedded CLI？

**未找到 OpenAI 支持的“只锁 bundled CLI 版本”机制。**

OpenAI 工程师甚至明确不推荐把 Desktop 内的 binary 替换/指向其他 CLI，因为 App bundle 的版本组合是专门测试的。([GitHub][7])

也不建议：

```text
cp /Applications/ChatGPT.app/Contents/Resources/codex ~/.myapp/codex
```

作为 pin 方案，因为现在 Codex package 还可能依赖 sibling helpers。例如当前 Desktop bundle 中就存在：

```text
codex-code-mode-host
```

并且实际出现过长驻 app-server 因原 binary/helper 路径被升级替换而失效的问题。([GitHub][23])

如果你需要真正 pin：

> **用 OpenAI standalone installer 安装指定 `--release X.Y.Z`，不要试图 pin ChatGPT.app 内部的那个 binary。**

**置信度：**

* 查询版本：**社区/官方仓库实测，极高**
* bundled CLI 会随 App bundle 更新而改变：**高置信度推断 + 实测**
* 单独 pin embedded CLI：**未找到官方支持**
* standalone explicit release 是 pin 方案：**官方明确**

---

# macOS 多实例环境下选择默认 Codex Runtime 的推荐优先级

下面这张表是**针对 Codex As Subagent 的工程建议，不是 OpenAI 官方排名**。

|     优先级 | Candidate                                                              | 建议                               | 原因                                                     |
| ------: | ---------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------ |
|   **0** | 用户显式配置 `codex_binary`                                                  | **绝对最高**                         | 用户主动指定；仍必须做 version/schema/probe                       |
|   **1** | **OpenAI standalone managed install，显式 pinned release**                | **最佳默认 runtime**                 | 官方发行、完整 package、版本可控、可以稳定 pin、共用默认 CODEX_HOME/auth     |
|   **2** | PATH 中用户主动安装的稳定 `codex`                                                | **非常合适**                         | 尊重用户环境；通常来自 standalone/npm/brew；升级比 Desktop bundle 更可控 |
|   **3** | 已知 standalone managed `current/bin/codex`                              | **合适**                           | 官方 installer 完整 runtime；如果是 latest channel 要注意 updater |
|   **4** | Homebrew known path `/opt/homebrew/bin/codex` / `/usr/local/bin/codex` | **合适 fallback**                  | 官方支持安装方式；路径稳定；仍需 capability probe                      |
|   **5** | `/Applications/ChatGPT.app/Contents/Resources/codex`                   | **可用 fallback，不建议默认优先于独立稳定 CLI** | 完整官方 binary、通常已有认证；但版本随 App 自动变化，而且历史上常为 alpha         |
|   **6** | `/Applications/Codex.app/Contents/Resources/codex`                     | **Legacy fallback**              | 旧官方 App bundle；产品已迁移到 ChatGPT.app                      |
| **不建议** | IDE extension 内私有 runtime                                              | **不要自动扫描依赖**                     | 没有稳定公开路径/ABI，extension 更新生命周期也不是你的项目所有                 |

我会把实际 selector 写成这样的逻辑：

```text
Discover candidates
        ↓
canonicalize + deduplicate realpath
        ↓
--version
        ↓
reject obviously unsupported / broken candidates
        ↓
generate stable JSON schema
        ↓
required API capability check
        ↓
ephemeral initialize smoke test
        ↓
rank compatible candidates
        ↓
select one for this Server lifetime
```

排序权重不要只看 location，而应该类似：

```text
explicit override
    >
pinned official stable runtime
    >
compatible stable user CLI
    >
compatible auto-moving runtime
    >
alpha App-bundled fallback
```

这还有一个直接的设计建议：**把 runtime discovery 和 app-server protocol compatibility 做成同一个模块，而不是“先找到一个 codex，就默认它能用”。**你真正要发现的不是“机器上有没有叫 `codex` 的文件”，而是：

> **机器上有哪些能够满足 Codex As Subagent 所需 stable app-server contract 的 Codex runtime。**

这会比单纯的 PATH-first discovery 健壮很多。

[1]: https://github.com/openai/codex/issues/38104?utm_source=chatgpt.com "Support selecting a config profile for app-server and Desktop via environment variable · Issue #38104 · openai/codex · GitHub"
[2]: https://formulae.brew.sh/cask/codex "Homebrew Formulae: codex"
[3]: https://openai.com/index/introducing-the-codex-app/?utm_source=chatgpt.com "Introducing the Codex app | OpenAI"
[4]: https://help.openai.com/en/articles/20001276/?utm_source=chatgpt.com "Moving to the new ChatGPT desktop app | OpenAI Help Center"
[5]: https://formulae.brew.sh/cask/codex-app?utm_source=chatgpt.com "Homebrew Formulae: codex-app"
[6]: https://formulae.brew.sh/cask/chatgpt "Homebrew Formulae: chatgpt"
[7]: https://github.com/openai/codex/discussions/12349?utm_source=chatgpt.com "App Integration · openai codex · Discussion #12349 · GitHub"
[8]: https://github.com/openai/codex/issues/38948?utm_source=chatgpt.com "macOS desktop: closing subagents leaves app-server at >100% CPU and residual node_repl sessions · Issue #38948 · openai/codex · GitHub"
[9]: https://github.com/openai/codex/issues/37403?utm_source=chatgpt.com "[macOS][regression] Desktop cannot resume Remote Control / CLI thread: `already has an active writer` after latest update · Issue #37403 · openai/codex · GitHub"
[10]: https://help.openai.com/en/articles/20001275?utm_source=chatgpt.com "ChatGPT Work and Codex | OpenAI Help Center"
[11]: https://github.com/openai/codex/issues/34692?utm_source=chatgpt.com "Add an opt-in automatic update setting for Codex CLI · Issue #34692 · openai/codex · GitHub"
[12]: https://developers.openai.com/codex/auth "Authentication | ChatGPT Learn"
[13]: https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs?utm_source=chatgpt.com "codex/codex-rs/config/src/config_toml.rs at main · openai/codex · GitHub"
[14]: https://github.com/openai/codex/issues/34807?utm_source=chatgpt.com "ChatGPT Desktop startup rewrites bundled computer-use MCP to enabled=false while plugin stays enabled · Issue #34807 · openai/codex · GitHub"
[15]: https://github.com/openai/codex/issues/23417?utm_source=chatgpt.com "app-server thread/start ignores profile model_provider from -p · Issue #23417 · openai/codex · GitHub"
[16]: https://openai.com/index/unlocking-the-codex-harness/?utm_source=chatgpt.com "Unlocking the Codex harness: how we built the App Server | OpenAI"
[17]: https://github.com/openai/codex/issues/37568?utm_source=chatgpt.com "macOS app quits on launch after update: managed app-server daemon stays on old version (0.143.0 vs bundled 0.147.0-alpha.6.5) -> initialize handshake timeout · Issue #37568 · openai/codex · GitHub"
[18]: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md?utm_source=chatgpt.com "codex/codex-rs/app-server/README.md at main · openai/codex · GitHub"
[19]: https://github.com/openai/codex/issues/42099?utm_source=chatgpt.com "0.151.0 regression: app-server thread/start no longer persists zero-turn threads, breaking resume · Issue #42099 · openai/codex · GitHub"
[20]: https://github.com/openai/codex/issues/25544?utm_source=chatgpt.com "app-server README lists nonexistent tool/requestUserInput method · Issue #25544 · openai/codex · GitHub"
[21]: https://developers.openai.com/codex/app-server "Codex App Server | ChatGPT Learn"
[22]: https://github.com/openai/codex/issues/13747?utm_source=chatgpt.com "Codex App bundles codex-cli 0.108.0-alpha.12 and fails on macOS, while standalone codex-cli 0.105.0 works on the same machine · Issue #13747 · openai/codex"
[23]: https://github.com/openai/codex/issues/44261?utm_source=chatgpt.com "Remote Control app-server survives Homebrew upgrade from `.upgrading` path, causing stale `codex-code-mode-host` spawn failure · Issue #44261 · openai/codex · GitHub"
