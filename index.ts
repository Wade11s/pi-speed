/**
 * pi-speed — shows session TPS (tokens per second) in the footer,
 * right after the context window indicator.
 *
 * - While streaming: estimates live TPS from delta character counts (~4 chars/token)
 * - On each assistant message end: computes exact TPS from real usage.output
 * - Replicates the built-in footer via ctx.ui.setFooter() to insert TPS
 *   after the context window indicator
 * - /tps command: show stats details; /tps reset resets stats
 *
 * Install: put this under ~/.pi/agent/extensions/pi-speed/ or .pi/extensions/pi-speed/
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

const CHARS_PER_TOKEN = 4; // rough estimate: 1 token ≈ 4 chars
const UPDATE_INTERVAL_MS = 200; // throttle for streaming status refresh

interface CurrentStream {
	startedAt: number; // timestamp of first delta
	chars: number; // accumulated delta char count
	lastUiUpdate: number;
}

interface SessionStats {
	messages: number; // completed assistant messages
	tokens: number; // total output tokens
	genMs: number; // total generation time (first delta → message end)
	lastTps: number | undefined;
}

// --- Helpers replicated from pi's built-in FooterComponent ---

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Speed tiers (based on 2026-08 cross-provider median benchmarks,
 * rounded quartiles across 122 models):
 * >150 🚀 green (~p75+) / 50–150 🚄 yellow (mainstream) / <50 🐢 red (~p20-)
 */
type SpeedTier = { emoji: string; color: "success" | "warning" | "error" };
const TIER_FAST = 150;
const TIER_SLOW = 50;

function speedTier(tps: number): SpeedTier {
	if (tps >= TIER_FAST) return { emoji: "🚀", color: "success" };
	if (tps >= TIER_SLOW) return { emoji: "🚄", color: "warning" };
	return { emoji: "🐢", color: "error" };
}

export default function (pi: ExtensionAPI) {
	let current: CurrentStream | undefined;
	const stats: SessionStats = { messages: 0, tokens: 0, genMs: 0, lastTps: undefined };
	let requestRender: (() => void) | undefined;

	function fmt(n: number): string {
		return n >= 100 ? n.toFixed(0) : n.toFixed(1);
	}

	/**
	 * Current TPS segment (rendered right after the context window indicator),
	 * or undefined when there is no data yet.
	 * Returns the numeric text plus tier; the emoji is prepended at render time
	 * and the number is colored by tier.
	 */
	function tpsSegment(): { value: string; suffix: string; tier: SpeedTier } | undefined {
		if (current && current.chars > 0) {
			const elapsed = (Date.now() - current.startedAt) / 1000;
			const liveTps = current.chars / CHARS_PER_TOKEN / elapsed;
			if (!(liveTps > 0)) return { value: "…", suffix: "", tier: { emoji: "🚄", color: "warning" } };
			return { value: fmt(liveTps), suffix: "tok/s", tier: speedTier(liveTps) };
		}
		if (stats.messages > 0 && stats.genMs > 0) {
			const avg = stats.tokens / (stats.genMs / 1000);
			return { value: fmt(avg), suffix: "tok/s avg", tier: speedTier(avg) };
		}
		return undefined;
	}

	function scheduleRender() {
		requestRender?.();
	}

	function throttledRender() {
		const now = Date.now();
		if (!current || now - current.lastUiUpdate >= UPDATE_INTERVAL_MS) {
			if (current) current.lastUiUpdate = now;
			scheduleRender();
		}
	}

	function resetStats() {
		stats.messages = 0;
		stats.tokens = 0;
		stats.genMs = 0;
		stats.lastTps = undefined;
		current = undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		// Reset stats on new session / session switch
		resetStats();

		if (ctx.mode !== "tui") return;

		// Replace the built-in footer with a replica that inserts TPS
		// right after the context window indicator.
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			return {
				dispose: () => {
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					// --- Gather the same data as the built-in footer ---
					const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
					let latestCacheHitRate: number | undefined;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const u = entry.message.usage;
							usageTotals.input += u.input;
							usageTotals.output += u.output;
							usageTotals.cacheRead += u.cacheRead;
							usageTotals.cacheWrite += u.cacheWrite;
							usageTotals.cost += u.cost.total;
							const latestPromptTokens = u.input + u.cacheRead + u.cacheWrite;
							latestCacheHitRate =
								latestPromptTokens > 0 ? (u.cacheRead / latestPromptTokens) * 100 : undefined;
						} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
							const u = entry.message.usage;
							usageTotals.input += u.input;
							usageTotals.output += u.output;
							usageTotals.cacheRead += u.cacheRead;
							usageTotals.cacheWrite += u.cacheWrite;
							usageTotals.cost += u.cost.total;
						} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
							const u = entry.usage;
							usageTotals.input += u.input;
							usageTotals.output += u.output;
							usageTotals.cacheRead += u.cacheRead;
							usageTotals.cacheWrite += u.cacheWrite;
							usageTotals.cost += u.cost.total;
						}
					}

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

					let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					// --- Stats line ---
					const statsParts: string[] = [];
					if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
					if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
					if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
					if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
					if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}
					// Kimi Coding is subscription-billed (approximates built-in behavior)
					const usingSubscription = ctx.model?.provider === "kimi-coding";
					if (usageTotals.cost || usingSubscription) {
						statsParts.push(`$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
					}

					const autoIndicator = " (auto)"; // compaction.enabled defaults to true
					const contextPercentDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}${autoIndicator}`
							: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
					let contextPercentStr: string;
					if (contextPercentValue > 90) {
						contextPercentStr = theme.fg("error", contextPercentDisplay);
					} else if (contextPercentValue > 70) {
						contextPercentStr = theme.fg("warning", contextPercentDisplay);
					} else {
						contextPercentStr = contextPercentDisplay;
					}
					statsParts.push(contextPercentStr);

					// ★ pi-speed: TPS right after the context window indicator
					// (emoji conveys the tier, the number is colored by tier)
					const tps = tpsSegment();
					if (tps) {
						const label = tps.suffix ? `${tps.value} ${tps.suffix}` : tps.value;
						statsParts.push(`${tps.tier.emoji} ${theme.fg(tps.tier.color, label)}`);
					}

					if (process.env.PI_EXPERIMENTAL === "1") {
						statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
					}

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					// --- Model name on the right side ---
					const modelName = ctx.model?.id || "no-model";
					let rightSideWithoutProvider = modelName;
					if (ctx.model?.reasoning) {
						const thinkingLevel = ctx.thinkingLevel || "off";
						rightSideWithoutProvider =
							thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
					}
					let rightSide = rightSideWithoutProvider;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
						if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
							rightSide = rightSideWithoutProvider;
						}
					}
					const rightSideWidth = visibleWidth(rightSide);
					const totalNeeded = statsLeftWidth + 2 + rightSideWidth;

					let statsLine: string;
					if (totalNeeded <= width) {
						const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
						statsLine = statsLeft + padding + rightSide;
					} else {
						const availableForRight = width - statsLeftWidth - 2;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const truncatedRightWidth = visibleWidth(truncatedRight);
							const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
							statsLine = statsLeft + padding + truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}

					// Dim each part separately (statsLeft may contain color codes)
					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);
					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					// Other extensions' status line (preserves built-in behavior, sorted by key)
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const sortedStatuses = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text));
						const statusLine = sortedStatuses.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});

	pi.on("message_start", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		current = { startedAt: 0, chars: 0, lastUiUpdate: 0 };
	});

	pi.on("message_update", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		const ev = event.assistantMessageEvent;
		if (!ev) return;
		if (ev.type !== "text_delta" && ev.type !== "thinking_delta" && ev.type !== "toolcall_delta") return;
		if (!current) current = { startedAt: 0, chars: 0, lastUiUpdate: 0 };
		if (current.startedAt === 0) current.startedAt = Date.now();
		current.chars += ev.delta.length;
		throttledRender();
	});

	pi.on("message_end", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;

		// Compute exact per-message TPS from real usage
		const output = event.message.usage?.output ?? 0;
		const elapsedMs = current && current.startedAt > 0 ? Date.now() - current.startedAt : 0;

		if (output > 0 && elapsedMs > 100) {
			stats.messages += 1;
			stats.tokens += output;
			stats.genMs += elapsedMs;
			stats.lastTps = output / (elapsedMs / 1000);
		}

		current = undefined;
		scheduleRender();
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		requestRender = undefined;
	});

	pi.registerCommand("tps", {
		description: "Show session TPS stats (/tps reset to reset)",
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() === "reset") {
				resetStats();
				scheduleRender();
				ctx.ui.notify("TPS stats reset", "info");
				return;
			}

			if (stats.messages === 0) {
				ctx.ui.notify("No completed assistant messages yet — send a prompt first.", "info");
				return;
			}

			const avg = stats.tokens / (stats.genMs / 1000);
			const lines = [
				`Messages: ${stats.messages}`,
				`Output tokens: ${stats.tokens.toLocaleString()}`,
				`Generation time: ${(stats.genMs / 1000).toFixed(1)}s`,
				`Last TPS: ${stats.lastTps !== undefined ? fmt(stats.lastTps) : "n/a"}`,
				`Session avg TPS: ${fmt(avg)}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
