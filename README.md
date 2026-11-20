# dsh-button-sample

![platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)
![language: JavaScript](https://img.shields.io/badge/language-JavaScript-F7DF1E)
![helper: PowerShell](https://img.shields.io/badge/helper-PowerShell-5391FE)
![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen)
![license: MIT](https://img.shields.io/badge/license-MIT-blue)

**简体中文** ・ [English](README.en.md)

给 **DSH 桌面版**（DeepSeek Harness Desktop）一次性装齐三样东西，每一项都能单独关掉：

- **悬浮电源按钮** —— 可拖动；贴到左右边缘会收成一条细边，鼠标移上去重新展开。点击弹出
  「重启 DSH / 退出 DSH」菜单。
- **侧栏电源图标** —— 坐在侧栏头像行里、头像左边，弹出同一个菜单。
- **继续生成按钮** —— 输入框右侧的一个三角按钮。上一轮被**长度上限截断**、被**手动停止**、
  或者**因为报错而停下**时出现，点一下接着写，一个字都不用敲。
- **停止按钮的转动圈** —— 点了「停止生成」但对话没有立刻停下时，按钮外圈转一圈提示
  「已经点到了，正在停」。

```
拖动 → 贴边收起 → 移上去展开 → 点击 →（有任务在跑才二次确认）→ 重启 或 退出
截断 / 停止 / 报错 → 输入框右侧出现 ▶ → 点击 → 模型接着上一次的文本往下写
点「停止生成」→ 未立刻停 → 外圈转动 → 停下后自动消失
```

DSH 桌面版本身没有界内重启入口：托盘菜单里的重启只在开发构建下出现，发布版只能先退出、
再从开始菜单重新打开。这个插件补的就是这一格；继续生成补的是「一轮没说完就没有下文了」
那一格。

- **只支持 Windows**：电源部分依赖 `taskkill`、WMI 与系统自带的 Windows PowerShell 5.1。
  继续生成不依赖平台，但它和电源功能同包，所以整包声明 `os: win32`。
- **零依赖**：纯 JS，不 import 任何 Harness 客户端包。
- **不读别的插件的 DOM 或样式**：三个落点都走官方槽位（`sidebar.footer.action`、
  `conversation.input.right`、`plugins.bundle.config`）。停止圈是唯一一处 DOM 观察，见下文。

---

## 安装

### 方式一：作为 profile 的本地 bundle（推荐，本机已验证）

```powershell
# 1) 放进 profile 的 vendor 目录
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\vendor\dsh-button-sample"
git clone https://github.com/aeclic/dsh-button-sample.git $dst

# 2) 让 profile 认识它
$dir = "$env:USERPROFILE\.dsh\profiles\desktop"
#    package.json 的 dsh.profile.bundles 里加一行 "dsh-button-sample"
#    package.json 的 dependencies 里加一行 "dsh-button-sample": "file:vendor/dsh-button-sample"
```

然后在 GUI 的「设置 → 插件」里启用 **dsh-button-sample**。

### 方式二：直接拷进 node_modules

```powershell
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-button-sample"
git clone https://github.com/aeclic/dsh-button-sample.git $dst
```

与方式一等效，只是绕开了 bundler 的依赖登记；升级时记得删掉旧目录再拉。

装好后**重启 DSH**。三个界面应该都在：侧栏底部的电源图标、输入框右侧的继续按钮（仅在可继续时
出现）、以及该插件卡片里的三个开关。

---

## 三个开关

插件的设置页（「设置 → 插件 → dsh-button-sample」）里有三行独立开关，存在
`<profile>/dsh-button-sample.json`：

| 开关 | 默认 | 关掉之后 |
| --- | --- | --- |
| 悬浮电源按钮 | 开 | 悬浮球消失，侧栏电源不受影响 |
| 侧栏底部电源图标 | 开 | 侧栏图标消失 |
| 继续生成按钮 | 开 | 输入框右侧不再出现三角按钮 |

插件卡片上的总开关控制整个包，三行开关控制包内的单个界面。

---

## 继续生成：它在哪些情况下可用

按钮只在「上一轮已经结束、而且还能接着写」时出现。判断依据是最后一条 `turn/end` 的
`reason.kind`：

| 结束原因 | 出现按钮 | 点下去会发生什么 |
| --- | --- | --- |
| `max-tokens` | 是 | 从被截断的那句话继续写 |
| `aborted` / `interrupted`（手动停止） | 是 | 从停下的地方继续写 |
| `error`（限流、服务端错误、超时、传输中断、空响应、流被关闭等） | 是 | 从断点继续；若这一轮一个 token 都没出，则重新作答 |
| `blocked`（步骤被准入规则拒绝） | 是 | 重新发起这一轮 |
| `forked` | 是 | 在被复制出来的分支上继续 |
| `completed` | 否 | 这一轮已自然说完，没有可续的 |

悬停时按钮的 tooltip 会说明属于哪一种。「重新生成」是按钮在没有任何 assistant 文本可续时的
写法——它说实话：这一下是重答，不是续写。

### 为什么报错也能继续

DSH 自带的 `conversationContinuation` 投影只承认六个错误码（`RATE_LIMIT`、`SERVER`、
`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`、`STREAM_CLOSED`）。其余错误——比如上游返回
一个没归类的 5xx、工具激活失败、`UNKNOWN`——在自带逻辑里是没有继续入口的。这个包把判定
放宽到「所有非 `completed` 的结束原因」，因为这些情况下**历史仍然停在一个可以续的前缀上**，
用户的意图也一样清楚：接着来。

### 它是怎么做到的（不改一个字提示词）

关键约束：发出去的请求必须以**被截断的那条 assistant 消息结尾**，模型才会续写前缀而不是
另起一句回答。所以不能插入任何新的提示词文本。

做法是往 inbox 里塞一条 `source.kind === 'runtime-context'` 的消息。
`AgentLoop.step()` 只用这个 kind 当作「开始一轮」的开关，**故意不把它写进会话表面**，于是
`deriveMessages()` 看不到它，模型收到的历史与被截断那一刻逐字节相同。

但仅此还不够：`agent/pre-step` 是个 waterfall，time-context、plan-mode、instructions、
session-reference 这些投影插件都会往 `decision.messages` 里追加自己的 user 消息，而**那些是
会落进会话表面的**。只要多出一条尾随的 user 消息，前缀续写就退化成了全新回答。所以本包在
该事件上用 `{ prepend: true }` 抢在最前面，包住其余监听器，看到组装完的结果后把除自己那条
nudge 之外的全部丢掉。

（如果用户自己也在同一步里打了字，则整批原样放行——那时候用户的意思显然是正常发一条消息。）

---

## 停止按钮的转动圈

DSH 的「停止生成」点下去是**异步**的：点击只是把取消请求交给 Host，那一轮要等流真正关闭才
结算。在这中间的几百毫秒里，按钮看起来和「点了没反应」一模一样，于是人会再点一次。

这个包在**按下时**先什么都不画，等 **350ms**：

- 如果这一轮在这段宽限期内就停了（常见情况，按钮会从「停止」变回「发送」），**不画圈**——
  不制造一段并不存在的等待。
- 如果还没停，就在按钮外圈画一个转动的环，跟着按钮的位置走，直到按钮消失、标签不再是
  「停止生成」、或者 15 秒兜底超时。

所以这个圈只说一件事：「你点到了，还在停」。

实现上有两个刻意的选择：

1. **圈是页面级浮层（`position: fixed`），不是按钮的子节点。** 那个按钮的子树归 React 所有，
   往里塞节点会在下一次 reconcile 时被扫掉；把按钮改成 `position: relative` 来承载绝对定位
   的子元素，又等于改动一个不属于本插件的控件。浮层按按钮的 `getBoundingClientRect()` 定位，
   两边都不碰。
2. **按下事件在 `document` 的捕获阶段读取。** 这样无论按钮自己的 React handler 做了什么
   （抛错、空实现），圈都不受影响——这正是要回答的问题。

停止按钮没有自己的 data 属性，唯一的稳定抓手是 `aria-label`，所以包内列出了 DSH 已发行的
8 种语言里「停止生成」的写法。新增语言时该列表要跟着加一行。

---

## 已知边界

- **仅 Windows**（整包 `os: win32`），因为电源功能需要 `taskkill` / WMI / PowerShell 5.1。
- **继续生成依赖 `runtime-context` 这一内部约定**。它在本机 0.2.2-rc.5 上实测成立；如果
  上游改了 `AgentLoop.step()` 对该 kind 的处理方式，续写会退化成「重新回答」——不会报错，
  只是效果变差。
- **停止圈的 350ms 宽限期是经验值**。网络很慢时圈会更早出现，很局部的机器上可能几乎看不到；
  两种都不影响正确性。
- **停止圈不认自定义语言包**：如果给 DSH 装了本包未列出语言的翻译，停止按钮的 `aria-label`
  不在列表里，圈就不会出现。加一行即可修好。

---

## 开发

`lib/` 是**直接发布的产物**，没有构建步骤。改动后跑测试：

```sh
node test/run.cjs
```

五个套件都以真实的 `lib/` 文件为对象，用手写的 Cordis context、DOM 与时钟替身驱动：

| 套件 | 覆盖 |
| --- | --- |
| `bundle.test.cjs` | 浏览器半的工厂形状、slot 注册与卸载 |
| `guard.test.cjs` | `agent/pre-step` 纯净性守卫的五种输入 |
| `host.test.cjs` | continue 判定矩阵、两条路由、鉴权栅栏、配置读写 |
| `continue-button.test.cjs` | 按钮的显示条件、每种结束原因的文案、点击、忙碌、失败、卸载 |
| `stop-ring.test.cjs` | 宽限期、浮层定位、跟随、四条清除路径、兜底、释放 |

---

## 来源与许可

MIT。本仓库 **fork 自 [WhichWitchWin/dsh-power-button](https://github.com/WhichWitchWin/dsh-power-button)**
（电源部分整体来自上游，含 `lib/restart-helper.ps1`），并合并了
`dsh-continue` 的继续生成能力，在此基础上做了两处扩展：可继续的结束原因从三种放宽到六种，
以及停止按钮的转动圈。

原上游的设计笔记仍在 `docs/DESIGN.md`，它逐条记录了电源部分每个反直觉决定的取证与实测数据；
本 fork 新增的部分见上面的「继续生成」与「停止按钮的转动圈」两节。
