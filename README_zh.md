# pi-speed

[English](README.md) | 简体中文

pi 扩展：在原生 `Working…` 后用括号显示整轮回复用时；footer 按「首 Token 等待（TTFT）→ TPS → session 累计回复用时」显示指标。

## 功能

- **速度档位**：≥150 tok/s 🚀 绿色 / 50–<150 🚄 黄色 / <50 🐢 红色
- **实时 TPS**：Unicode delta 字符数 ÷4 粗估，标记 `≈`；积累至少 200ms 后显示，避免启动时数值不稳定
- **最终 TPS**：provider 报告的 `usage.output` ÷ 客户端生成耗时（首个非空 delta → 消息结束）
- **Session 平均 TPS**：有有效耗时的总 tokens ÷ 总生成时间，即按耗时加权。保留短回复；无 delta / 零耗时不参与 TPS 平均，但仍计入消息和 token 数
- **整轮回复用时**：调用准备开始 → 最终 `agent_settled`，包含 thinking、工具执行、重试、压缩和自动续跑；运行时通过原生 `ctx.ui.setWorkingMessage()` 显示为输入框上方的 `Working… (12.3s)`，结束后恢复默认提示，最近整轮用时可在 `/tps` 查看
- **⚡️ 首 Token 等待（TTFT）**：整轮开始 → 首个非空 text / thinking / tool-call delta；等待时保留 `⏳`，收到后切换为 emoji 样式 `⚡️` 并固定耗时，没有观察到 delta 则显示 `n/a`
- **🕒 TOTAL Session 累计回复用时**：已测量整轮耗时之和，运行时加上当前已用时间，不含两轮之间的用户空闲时间
- context window 后按 **TTFT → TPS → TOTAL** 排列，统一「图标 → 标签 → 数值 → 单位」，指标间用 ` · ` 分隔；标签 / 单位弱化，数值清晰，仅 TPS 数值按档位着色，平均值标记放在 `TPS(avg)` 标签上
- 窄终端将整组指标换行，顺序不变；整轮用时不再重复显示在 footer
- 保留其他扩展的 status 行
- `/tps` — 查看消息 / token 数、TPS 有效样本覆盖、最近整轮用时 / TTFT、结束状态和累计用时
- `/tps reset` — 持久化重置速度及用时统计（仅空闲时允许）
- `/new` 从零开始；`/resume`、reload 恢复统计；`/fork`、`/tree` 跟随当前分支已有统计

## 样式示例

```
# 输入框上方的原生 Working 提示（运行时）
⠋ Working… (5.0s)

# Footer：TTFT → TPS → TOTAL
12.3%/128k (auto) ⏳ TTFT 1.2s… · 🕒 TOTAL 4m21s
12.3%/128k (auto) ⚡️ TTFT 1.2s · 🚀 TPS ≈168 tok/s · 🕒 TOTAL 4m25s
12.3%/128k (auto) ⚡️ TTFT 1.2s · 🚄 TPS(avg) 95.2 tok/s · 🕒 TOTAL 4m32s

# 窄终端：整组指标换到统计行下方
12.3%/128k (auto)
⚡️ TTFT 1.2s · 🐢 TPS(avg) 18.3 tok/s
🕒 TOTAL 4m32s
```

## 安装

全局（所有项目）：

```bash
pi install git:github.com/Wade11s/pi-speed
```

或手动 symlink：

```bash
ln -s /path/to/pi-speed ~/.pi/agent/extensions/pi-speed
```

或项目本地：

```bash
mkdir -p .pi/extensions
ln -s /path/to/pi-speed .pi/extensions/pi-speed
```

或临时测试：

```bash
pi -e ./index.ts
```

## 阈值依据

档位阈值来自 BenchLM 跨 provider 运行时中位数基准（2026-08-21，124 模型；剔除 Celeris-1 / Mercury 2 扩散架构特例后 n=122）：

- 分布：p25 ≈ 58、中位数 ≈ 92、p75 ≈ 142
- 取整为 **50 / 150**：🐢 约 18%（Kimi K 系列、Claude 4.x Sonnet、DeepSeek V3.2 等）；🚄 约 58% 主力区（GPT-5.x、Claude Opus/Sonnet 5、GLM-5、Gemini Pro、DeepSeek V4）；🚀 约 24%（Gemini Flash 系列、GPT-5.4 mini/nano、LPU/Cerebras 托管模型）
- 阈值可在 `index.ts` 中改 `TIER_FAST` / `TIER_SLOW`

## 说明

- 自定义 footer 复刻自 pi 内建 `FooterComponent`，pi 升级后如内建 footer 样式变化，需同步调整本扩展
- Lightning 使用 U+26A1 + U+FE0F 请求 emoji 呈现，并提供黄色前景回退；是否显示彩色 emoji 仍取决于终端和字体
- 所有耗时使用单调时钟 `performance.now()`；整轮进行中每 200ms 更新 Working 括号内的计时和 footer，首 Token 等待和工具执行期间也持续计时，最终结束 / 关闭 / session 切换时停止刷新并恢复默认 Working 提示
- 使用 Pi 原生 Working 提示，不添加额外 widget，不改动原生 spinner 或重试 / 压缩提示；即使另一个扩展替换 footer，Working 计时仍继续
- TPS 与整轮耗时刻意采用不同口径：TPS 排除首个 delta 前的等待和工具执行，整轮耗时包含这些时间。TTFT 是客户端观察到首个输出片段的时间，不一定是答案正文的首字
- 字符估算受语言、代码、工具参数和隐藏推理影响。Pi 的 `usage.output` 包含已报告的 reasoning tokens；最终 TPS 仍是客户端观测值，不能当作精确的服务端解码基准
- 统计保存为不进入模型上下文的 session entry。旧回复缺少历史测量时无法补算；fork 只继承选定位置之前已有的统计快照，不恢复正在进行的整轮计时
- 中止 / 失败回复也计入实际耗时并标记状态；自动重试、续跑（包括同一次运行中排队的工作）在最终结束前归入同一轮
- `(sub)` 订阅标记仅对 kimi-coding 生效（内建的 modelRuntime 订阅检测对扩展不可见）

## 开发验证

已针对 Pi 1.0.4 验证，开发依赖要求 Node.js ≥22.19。

```bash
npm ci
npm test
npm run typecheck
```
