# pi-speed

Pi 扩展：在 footer 的 context window 后实时显示当前 session 的 TPS（tokens per second），带速度档位指示。

## 功能

- **实时 TPS**：流式输出期间，根据 delta 字符数实时估算（约 4 chars/token），每 200ms 刷新
- **最终 TPS**：每条 assistant 消息结束后，用真实 `usage.output` 与生成耗时（首个 delta → 结束）计算精确 TPS
- **Session 平均 TPS**：累计所有消息的 output tokens 与生成时间，显示 `avg`
- 显示位置：footer 统计行，**紧跟在 context window 指示器之后**（如 `12.3%/128K (auto) ⚡47.8 avg`）
- 通过 `ctx.ui.setFooter()` 复刻内建 footer 实现插入；其他扩展的 status 行不受影响
- `/tps` — 查看统计详情（消息数、总 tokens、生成耗时、last/avg TPS）
- `/tps reset` — 重置统计
- `/new`、`/resume`、`/fork` 切换 session 时自动重置

## 安装

全局（所有项目）：

```bash
ln -s /Users/hwj/Desktop/Automation/my-pi-extensions/pi-speed ~/.pi/agent/extensions/pi-speed
```

或项目本地：

```bash
mkdir -p .pi/extensions
ln -s /Users/hwj/Desktop/Automation/my-pi-extensions/pi-speed .pi/extensions/pi-speed
```

或临时测试：

```bash
pi -e ./index.ts
```

## 阈值依据

档位阈值来自 BenchLM 跨 provider 运行时中位数基准（2026-08-21，124 模型，剔除 Celeris-1/Mercury 2 扩散架构特例后 n=122）：

- 分布：p25 ≈ 58、中位数 ≈ 92、p75 ≈ 142
- 取整为 **50 / 150**：🐢 约 18%（Kimi K 系列、Claude 4.x Sonnet、DeepSeek V3.2 等）；🚄 约 58% 主力区（GPT-5.x、Claude Opus/Sonnet 5、GLM-5、Gemini Pro、DeepSeek V4）；🚀 约 24%（Gemini Flash 系列、GPT-5.4 mini/nano、LPU/Cerebras 托管模型）
- 阈值可在 `index.ts` 中改 `TIER_FAST` / `TIER_SLOW`

## 说明

- 自定义 footer 复刻自 pi 内建 `FooterComponent`，pi 升级后如内建 footer 样式变化，需同步调整本扩展

- 速度档位（基于 2026-08 跨 provider 中位数基准，122 模型四分位取整）：>150 tok/s 🚀 绿色 / 50–150 🚄 黄色 / <50 🐢 红色
- 流式期间显示实时估算值（字符数 ÷ 4），空闲时显示 session 平均值（如 `⚡ 47.8 tok/s avg`）

## 样式示例

```
↑1.2k ↓8.5k R230k CH95.2% $0.123 12.3%/128K (auto) 🚀 95.2 tok/s      ← >150（绿色）
↑1.2k ↓8.5k R230k CH95.2% $0.123 12.3%/128K (auto) 🚄 47.8 tok/s avg  ← 50–150（黄色）
↑1.2k ↓8.5k R230k CH95.2% $0.123 12.3%/128K (auto) 🐢 18.3 tok/s      ← <50（红色）
```
- 平均值使用 provider 报告的真实 token 数
- `(sub)` 订阅标记仅对 kimi-coding 生效（内建的 modelRuntime 订阅检测对扩展不可见）
- 生成耗时不包含首 token 延迟（TTFT），从第一个 delta 开始计时，因此 TPS 反映的是纯吐字速度
