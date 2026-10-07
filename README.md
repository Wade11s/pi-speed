# pi-speed

English | [简体中文](README_zh.md)

A pi extension that adds parenthesized whole-reply time to Pi's native `Working…` indicator, with footer metrics ordered as time to first token (TTFT) → TPS → cumulative session reply time.

## Features

- **Speed tiers**: ≥150 tok/s 🚀 green / 50–<150 🚄 yellow / <50 🐢 red
- **Live TPS**: approximate Unicode delta character counts ÷4, marked `≈`; waits for a 200ms sample window to avoid unstable startup values
- **Final TPS**: provider-reported `usage.output` ÷ client-observed generation time (first non-empty delta → message end)
- **Session average TPS**: total measured tokens ÷ total measured generation time (a time-weighted average). Short replies are retained; unknown/zero durations are excluded from the TPS sample, not from message/token counts
- **Whole-reply time**: call preparation → final `agent_settled`, including thinking, tools, retries, compaction, and automatic continuation; displayed above the input as `Working… (12.3s)` via the native `ctx.ui.setWorkingMessage()`. The default label is restored when done; `/tps` retains the latest completed duration
- **⚡️ TTFT**: reply start → first non-empty text/thinking/tool-call delta; shows `⏳` while waiting, then switches to emoji-style `⚡️` and freezes the duration. No observed delta means `n/a`
- **🕒 TOTAL Session reply time**: sum of measured whole replies, including the current reply while running, excluding idle time between replies
- After the context window indicator, metrics appear as **TTFT → TPS → TOTAL**, consistently ordered as icon → label → value → unit and separated by ` · `. Labels/units are muted; values stay legible and only TPS values use tier colors. Averaging mode belongs to the `TPS(avg)` label
- The entire metric group wraps on narrow terminals without changing order; whole-reply elapsed time is no longer duplicated in the footer
- Other extensions' status lines are preserved
- `/tps` — show message/token counts, measured TPS coverage, latest reply/TTFT, outcome, and cumulative reply time
- `/tps reset` — persistently reset speed and timing stats (only while idle)
- `/new` starts fresh; `/resume` and reload restore saved stats; `/fork` and `/tree` follow the selected branch's saved history

## Style Examples

```
# Native Working indicator above the input while running
⠋ Working… (5.0s)

# Footer: TTFT → TPS → TOTAL
12.3%/128k (auto) ⏳ TTFT 1.2s… · 🕒 TOTAL 4m21s
12.3%/128k (auto) ⚡️ TTFT 1.2s · 🚀 TPS ≈168 tok/s · 🕒 TOTAL 4m25s
12.3%/128k (auto) ⚡️ TTFT 1.2s · 🚄 TPS(avg) 95.2 tok/s · 🕒 TOTAL 4m32s

# Narrow terminal: the metric group wraps below the stats line
12.3%/128k (auto)
⚡️ TTFT 1.2s · 🐢 TPS(avg) 18.3 tok/s
🕒 TOTAL 4m32s
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
- Lightning uses U+26A1 + U+FE0F to request emoji presentation, with a yellow foreground fallback; color emoji rendering still depends on the terminal and font
- All elapsed times use a monotonic clock (`performance.now()`); the Working timer and footer refresh every 200ms during a reply, including first-token and tool waits. Settlement, shutdown, and session switches stop updates and restore the default Working label
- Uses Pi's native Working indicator, not an extra widget; preserves the spinner and retry/compaction indicators. Working elapsed time continues even if another extension replaces the footer
- TPS and reply time deliberately have different scopes: TPS excludes pre-delta waiting and tool execution; whole-reply time includes them. TTFT is a client-observed first output fragment, not necessarily the first visible answer word
- Character-based live estimates vary with language, code, tool arguments, and hidden reasoning. Pi's `usage.output` includes reported reasoning tokens; final TPS is still a client-observed measurement, not an exact server decoding benchmark
- Stats are stored as non-context session entries. Older replies without saved measurements cannot be reconstructed; a fork inherits only snapshots before its selected point, not an in-progress reply timer
- Aborted/failed replies contribute their actual elapsed time and are labeled accordingly. Automatic retries/continuation (including queued work in the same run) remain in the same reply until final settlement
- The `(sub)` subscription marker only applies to kimi-coding (the built-in modelRuntime subscription detection is not exposed to extensions)

## Development

Tested against Pi 1.0.4. Node.js ≥22.19 is required for the development dependencies.

```bash
npm ci
npm test
npm run typecheck
```
