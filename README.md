# pi-speed

English | [简体中文](README_zh.md)

A pi extension that shows the current session's TPS (tokens per second) in the footer, right after the context window indicator, with speed-tier indication.

## Features

- **Speed tiers** (based on 2026-08 cross-provider median benchmarks, rounded quartiles across 122 models): >150 tok/s 🚀 green / 50–150 🚄 yellow / <50 🐢 red
- **Live TPS**: estimated from streaming delta character counts (÷4) during output, refreshed every 200ms
- **Final TPS**: computed per assistant message from the real `usage.output` and generation time (first delta → message end)
- **Session average TPS**: token-weighted average across all messages
- Display position: on the footer stats line, **right after the context window indicator** (e.g. `12.3%/128K (auto) 🚄 47.8 tok/s avg`)
- Implemented via `ctx.ui.setFooter()` replicating the built-in footer; other extensions' status lines are unaffected
- `/tps` — show stats details (message count, total tokens, generation time, last/avg TPS)
- `/tps reset` — reset stats
- Stats reset automatically on `/new`, `/resume`, `/fork` session switches

## Style Examples

```
↑1.2k ↓8.5k R230k CH95.2% $0.123 12.3%/128K (auto) 🚀 95.2 tok/s      ← fast (green)
↑1.2k ↓8.5k R230k CH95.2% $0.123 12.3%/128K (auto) 🚄 47.8 tok/s avg  ← medium (yellow)
↑1.2k ↓8.5k R230k CH95.2% $0.123 12.3%/128K (auto) 🐢 18.3 tok/s      ← slow (red)
```

## Install

Global (all projects):

```bash
pi install git:github.com/Wade11s/pi-speed
```

Or symlink manually:

```bash
ln -s /path/to/pi-speed ~/.pi/agent/extensions/pi-speed
```

Or project-local:

```bash
mkdir -p .pi/extensions
ln -s /path/to/pi-speed .pi/extensions/pi-speed
```

Or for a quick test:

```bash
pi -e ./index.ts
```

## Threshold Rationale

Tier thresholds come from the BenchLM cross-provider runtime median benchmark (2026-08-21, 124 models; n=122 after excluding the Celeris-1 / Mercury 2 diffusion-architecture outliers):

- Distribution: p25 ≈ 58, median ≈ 92, p75 ≈ 142
- Rounded to **50 / 150**: 🐢 ~18% (Kimi K series, Claude 4.x Sonnet, DeepSeek V3.2, etc.); 🚄 ~58% mainstream (GPT-5.x, Claude Opus/Sonnet 5, GLM-5, Gemini Pro, DeepSeek V4); 🚀 ~24% (Gemini Flash family, GPT-5.4 mini/nano, LPU/Cerebras-hosted models)
- Thresholds are configurable via `TIER_FAST` / `TIER_SLOW` in `index.ts`

## Notes

- The custom footer is replicated from pi's built-in `FooterComponent`; if a pi upgrade changes the built-in footer style, this extension needs to be updated accordingly
- Live TPS is an estimate (chars ÷ 4) during streaming; the idle average uses the provider-reported real token count
- The `(sub)` subscription marker only applies to kimi-coding (the built-in modelRuntime subscription detection is not exposed to extensions)
- Thinking tokens are included in both timing and token counts (i.e. TPS reflects throughput including reasoning)
