/**
 * pi-speed — TTFT, TPS and cumulative reply time in the footer;
 * whole-reply elapsed time in Pi's native Working indicator.
 *
 * - While streaming: estimates live TPS from delta character counts (~4 chars/token)
 * - On each assistant message end: computes client-observed TPS from usage.output
 * - Replicates the built-in footer via ctx.ui.setFooter() to insert TTFT → TPS → TOTAL
 *   after the context window indicator
 * - Whole-reply time includes tools/retries; TTFT is the first observed non-empty delta
 * - /speed command: show speed and timing details; /speed reset resets stats
 *
 * Install: put this under ~/.pi/agent/extensions/pi-speed/ or .pi/extensions/pi-speed/
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

const CHARS_PER_TOKEN = 4; // rough estimate: 1 token ≈ 4 chars
const UPDATE_INTERVAL_MS = 200; // throttle for streaming status refresh
const STATS_ENTRY = "pi-speed-stats";
const TTFT_EMOJI = "⚡️"; // U+26A1 + U+FE0F requests emoji, not monochrome text, presentation.

interface CurrentStream {
	startedAt: number | undefined; // monotonic time of first non-empty delta
	chars: number; // accumulated delta char count
	lastUiUpdate: number;
}

type ReplyOutcome = "completed" | "aborted" | "error";

interface CurrentReply {
	startedAt: number;
	ttftMs: number | undefined;
	outcome: ReplyOutcome;
}

interface SessionStats {
	messages: number; // completed assistant messages
	tokens: number; // total output tokens
	genMs: number; // measured generation time (first delta → message end)
	timedTokens: number; // only tokens with a matching, positive generation duration
	timedMessages: number;
	lastTps: number | undefined;
	replies: number;
	replyMs: number;
	lastReplyMs: number | undefined;
	lastTtftMs: number | undefined;
	lastOutcome: ReplyOutcome | undefined;
}

function emptyStats(): SessionStats {
	return {
		messages: 0, tokens: 0, genMs: 0, timedTokens: 0, timedMessages: 0, lastTps: undefined,
		replies: 0, replyMs: 0, lastReplyMs: undefined, lastTtftMs: undefined, lastOutcome: undefined,
	};
}

/** Ignore malformed/future snapshots instead of trusting arbitrary session data. */
function readStats(data: unknown): SessionStats | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (record.version !== 1 || !record.stats || typeof record.stats !== "object") return undefined;
	const source = record.stats as Record<string, unknown>;
	const snapshot = emptyStats();
	const required = ["messages", "tokens", "genMs", "timedTokens", "timedMessages", "replies", "replyMs"] as const;
	const optional = ["lastTps", "lastReplyMs", "lastTtftMs"] as const;
	for (const key of [...required, ...optional]) {
		const value = source[key];
		if (value === undefined && !required.includes(key as typeof required[number])) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
		Object.assign(snapshot, { [key]: value });
	}
	for (const key of ["messages", "timedMessages", "replies"] as const) {
		if (!Number.isSafeInteger(snapshot[key])) return undefined;
	}
	if (source.lastOutcome !== undefined) {
		if (source.lastOutcome !== "completed" && source.lastOutcome !== "aborted" && source.lastOutcome !== "error")
			return undefined;
		snapshot.lastOutcome = source.lastOutcome;
	}
	if (snapshot.timedMessages > snapshot.messages || snapshot.timedTokens > snapshot.tokens) return undefined;
	if (snapshot.replies > 0 && (snapshot.lastReplyMs === undefined || snapshot.lastOutcome === undefined)) return undefined;
	if (snapshot.lastReplyMs !== undefined && snapshot.lastReplyMs > snapshot.replyMs) return undefined;
	if (snapshot.lastTtftMs !== undefined && (snapshot.lastReplyMs === undefined || snapshot.lastTtftMs > snapshot.lastReplyMs))
		return undefined;
	return snapshot;
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 100) / 10;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const whole = Math.floor(seconds);
	const minutes = Math.floor(whole / 60);
	const remainder = (whole % 60).toString().padStart(2, "0");
	if (minutes < 60) return `${minutes}m${remainder}s`;
	return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, "0")}m${remainder}s`;
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
interface FooterMetric {
	emoji: string;
	label: string;
	value: string;
	unit?: string;
	color?: SpeedTier["color"];
}
const TIER_FAST = 150;
const TIER_SLOW = 50;

function speedTier(tps: number): SpeedTier {
	if (tps >= TIER_FAST) return { emoji: "🚀", color: "success" };
	if (tps >= TIER_SLOW) return { emoji: "🚄", color: "warning" };
	return { emoji: "🐢", color: "error" };
}

export default function (pi: ExtensionAPI) {
	let current: CurrentStream | undefined;
	const stats = emptyStats();
	let reply: CurrentReply | undefined;
	let requestRender: (() => void) | undefined;
	let liveTimer: ReturnType<typeof setInterval> | undefined;
	let setWorkingMessage: ExtensionContext["ui"]["setWorkingMessage"] | undefined;

	function fmt(n: number): string {
		return n >= 100 ? n.toFixed(0) : n.toFixed(1);
	}

	/**
	 * Current TPS segment (rendered between TTFT and cumulative reply time),
	 * or undefined when there is no data yet.
	 * The label contains the averaging mode; only the numeric value is colored by tier.
	 */
	function tpsSegment(): FooterMetric | undefined {
		if (current?.startedAt !== undefined && current.chars > 0) {
			const elapsed = (performance.now() - current.startedAt) / 1000;
			const liveTps = current.chars / CHARS_PER_TOKEN / elapsed;
			if (elapsed < UPDATE_INTERVAL_MS / 1000 || !Number.isFinite(liveTps) || liveTps <= 0)
				return { emoji: "🚄", label: "TPS", value: "…" };
			return { ...speedTier(liveTps), label: "TPS", value: `≈${fmt(liveTps)}`, unit: "tok/s" };
		}
		if (stats.timedMessages > 0 && stats.genMs > 0) {
			const avg = stats.timedTokens / (stats.genMs / 1000);
			return { ...speedTier(avg), label: "TPS(avg)", value: fmt(avg), unit: "tok/s" };
		}
		return undefined;
	}

	function scheduleRender() {
		requestRender?.();
	}

	function throttledRender() {
		const now = performance.now();
		if (!current || now - current.lastUiUpdate >= UPDATE_INTERVAL_MS) {
			if (current) current.lastUiUpdate = now;
			scheduleRender();
		}
	}

	function stopLiveTimer() {
		if (liveTimer !== undefined) clearInterval(liveTimer);
		liveTimer = undefined;
	}

	function clearWorkingMessage() {
		setWorkingMessage?.(); // No argument restores Pi's default working label.
		setWorkingMessage = undefined;
	}

	function updateLiveUI() {
		if (reply && setWorkingMessage) {
			const elapsed = Math.max(0, performance.now() - reply.startedAt);
			setWorkingMessage(`Working… (${formatDuration(elapsed)})`);
		}
		scheduleRender();
	}

	function startReply(ctx: ExtensionContext) {
		// agent_start can recur during retries/continuation: keep the original start.
		if (!reply) reply = { startedAt: performance.now(), ttftMs: undefined, outcome: "completed" };
		if (ctx.mode === "tui") {
			setWorkingMessage = ctx.ui.setWorkingMessage.bind(ctx.ui);
			if (liveTimer === undefined) {
				liveTimer = setInterval(updateLiveUI, UPDATE_INTERVAL_MS);
				liveTimer.unref?.();
			}
		}
		updateLiveUI();
	}

	function timingSegments(): FooterMetric[] {
		if (!reply && stats.replies === 0) return [];
		const elapsed = reply ? Math.max(0, performance.now() - reply.startedAt) : stats.lastReplyMs!;
		const ttft = reply ? reply.ttftMs : stats.lastTtftMs;
		const waiting = reply !== undefined && ttft === undefined;
		const ttftText = waiting ? `${formatDuration(elapsed)}…` : ttft === undefined ? "n/a" : formatDuration(ttft);
		return [
			{ emoji: waiting ? "⏳" : TTFT_EMOJI, label: "TTFT", value: ttftText },
			{ emoji: "🕒", label: "TOTAL", value: formatDuration(stats.replyMs + (reply ? elapsed : 0)) },
		];
	}

	function resetStats() {
		stopLiveTimer();
		clearWorkingMessage();
		Object.assign(stats, emptyStats());
		current = undefined;
		reply = undefined;
	}

	function persistStats() {
		// Custom entries never enter the model context.
		pi.appendEntry(STATS_ENTRY, { version: 1, stats: { ...stats } });
	}

	function restoreStats(ctx: ExtensionContext) {
		resetStats();
		// Branch-local snapshots make resume, fork and /tree follow the selected history.
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATS_ENTRY) continue;
			const snapshot = readStats(entry.data);
			if (snapshot) Object.assign(stats, snapshot);
		}
	}

	function finishReply(outcome?: ReplyOutcome) {
		if (!reply) return;
		const elapsed = Math.max(0, performance.now() - reply.startedAt);
		stats.replies += 1;
		stats.replyMs += elapsed;
		stats.lastReplyMs = elapsed;
		stats.lastTtftMs = reply.ttftMs;
		stats.lastOutcome = outcome ?? reply.outcome;
		reply = undefined;
		current = undefined;
		stopLiveTimer();
		clearWorkingMessage();
		persistStats();
		scheduleRender();
	}

	pi.on("before_agent_start", async (_event, ctx) => { startReply(ctx); });
	pi.on("agent_start", async (_event, ctx) => { startReply(ctx); });
	pi.on("agent_before_settle", async (event) => {
		if (reply) reply.outcome = event.outcome;
	});
	pi.on("agent_settled", async () => { finishReply(); });
	pi.on("session_tree", async (_event, ctx) => {
		restoreStats(ctx);
		scheduleRender();
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreStats(ctx);

		if (ctx.mode !== "tui") return;

		// Replace the built-in footer with TTFT → TPS → cumulative reply time.
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			function renderMetric(metric: FooterMetric): string {
				// Keep labels/units muted, without dimming values or emoji as a whole.
				const value = metric.color ? theme.fg(metric.color, metric.value) :
					metric.value.replace(/n\/a|[hms]|…/g, (unit) => theme.fg("dim", unit));
				// Yellow fallback when a terminal ignores the emoji presentation selector.
				const emoji = metric.emoji === TTFT_EMOJI ? theme.fg("warning", metric.emoji) : metric.emoji;
				const unit = metric.unit ? ` ${theme.fg("dim", metric.unit)}` : "";
				return `${emoji} ${theme.fg("dim", metric.label)} ${value}${unit}`;
			}

			return {
				dispose: () => {
					// The Working timer belongs to the reply, not this footer component.
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

					// Keep the same metric order inline and when wrapping: TTFT → TPS → TOTAL.
					const timings = timingSegments();
					const segments = timings.slice(0, 1);
					const tps = tpsSegment();
					if (tps) segments.push(tps);
					segments.push(...timings.slice(1));
					const metrics = segments.map(renderMetric);
					const separator = theme.fg("dim", " · ");
					const metricsText = metrics.join(separator);

					if (process.env.PI_EXPERIMENTAL === "1") {
						statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
					}

					const metricsInline = visibleWidth(`${statsParts.join(" ")} ${metricsText}`) + 2 +
						visibleWidth(ctx.model?.id || "no-model") <= width;
					let statsLeft = theme.fg("dim", statsParts.join(" "));
					if (metricsInline && metrics.length > 0) statsLeft += ` ${metricsText}`;
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

					// Base stats are already dimmed; do not dim the metric values again.
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);
					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
					const lines = [pwdLine, statsLeft + dimRemainder];
					if (!metricsInline) {
						let line = "";
						for (const segment of metrics) {
							const next = line ? `${line}${separator}${segment}` : segment;
							if (line && visibleWidth(next) > width) {
								lines.push(truncateToWidth(line, width, theme.fg("dim", "...")));
								line = segment;
							} else line = next;
						}
						if (line) lines.push(truncateToWidth(line, width, theme.fg("dim", "...")));
					}

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
		current = { startedAt: undefined, chars: 0, lastUiUpdate: 0 };
	});

	pi.on("message_update", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		const ev = event.assistantMessageEvent;
		if (!ev) return;
		if (ev.type !== "text_delta" && ev.type !== "thinking_delta" && ev.type !== "toolcall_delta") return;
		if (!ev.delta) return;
		if (!current) current = { startedAt: undefined, chars: 0, lastUiUpdate: 0 };
		const now = performance.now();
		if (current.startedAt === undefined) current.startedAt = now;
		if (reply && reply.ttftMs === undefined) reply.ttftMs = Math.max(0, now - reply.startedAt);
		current.chars += Array.from(ev.delta).length;
		throttledRender();
	});

	pi.on("message_end", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;

		if (reply) reply.outcome = event.message.stopReason === "aborted" ? "aborted" :
			event.message.stopReason === "error" ? "error" : "completed";
		const reportedOutput = event.message.usage?.output ?? 0;
		const output = Number.isFinite(reportedOutput) && reportedOutput > 0 ? reportedOutput : 0;
		const elapsedMs = current?.startedAt !== undefined ? performance.now() - current.startedAt : 0;
		const tps = elapsedMs > 0 ? output / (elapsedMs / 1000) : undefined;

		// Count every finalized message. Unknown/zero durations do not enter the TPS average.
		stats.messages += 1;
		stats.tokens += output;
		stats.lastTps = undefined;
		if (output > 0 && tps !== undefined && Number.isFinite(tps)) {
			stats.timedMessages += 1;
			stats.timedTokens += output;
			stats.genMs += elapsedMs;
			stats.lastTps = tps;
		}

		current = undefined;
		persistStats();
		scheduleRender();
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		// A normal shutdown may arrive before settlement (e.g. cancelling on exit).
		if (reply) finishReply(reply.outcome === "error" ? "error" : "aborted");
		stopLiveTimer();
		clearWorkingMessage();
		requestRender = undefined;
	});

	pi.registerCommand("speed", {
		description: "Show session speed and timing stats: TPS, TTFT and reply time (/speed reset to reset)",
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() === "reset") {
				if (reply || current) {
					ctx.ui.notify("Cannot reset stats while a reply is running.", "warning");
					return;
				}
				resetStats();
				persistStats();
				scheduleRender();
				ctx.ui.notify("Speed and reply timing stats reset", "info");
				return;
			}

			if (stats.messages === 0 && stats.replies === 0 && !reply) {
				ctx.ui.notify("No completed assistant messages yet — send a prompt first.", "info");
				return;
			}

			const avg = stats.genMs > 0 ? stats.timedTokens / (stats.genMs / 1000) : undefined;
			const lines = [
				`Messages: ${stats.messages}`,
				`Output tokens: ${stats.tokens.toLocaleString()}`,
				`Generation time: ${(stats.genMs / 1000).toFixed(1)}s`,
				`Last TPS: ${stats.lastTps !== undefined ? fmt(stats.lastTps) : "n/a"}`,
				`Session avg TPS: ${avg !== undefined ? fmt(avg) : "n/a"}`,
				`TPS samples: ${stats.timedMessages}/${stats.messages}`,
				`Replies: ${stats.replies}`,
				`Last reply: ${stats.lastReplyMs === undefined ? "n/a" : formatDuration(stats.lastReplyMs)}`,
				`Last TTFT: ${stats.lastTtftMs === undefined ? "n/a" : formatDuration(stats.lastTtftMs)}`,
				`Last outcome: ${stats.lastOutcome ?? "n/a"}`,
				`Session reply time: ${formatDuration(stats.replyMs)}`,
			];
			if (reply) {
				const elapsed = Math.max(0, performance.now() - reply.startedAt);
				lines.push(`Current reply: ${formatDuration(elapsed)} (running)`);
				lines.push(`Current TTFT: ${reply.ttftMs === undefined ? "waiting" : formatDuration(reply.ttftMs)}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
