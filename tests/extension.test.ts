import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../index.js";

type Entry = Record<string, unknown>;
type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;

function fixture(t: TestContext, entries: Entry[] = [], mode = "tui", ansi = false) {
	let now = 0;
	let wall = 1_000_000;
	let footer: ReturnType<FooterFactory> | undefined;
	let renders = 0;
	let branch = entries;
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const notifications: string[] = [];
	const statuses = new Map<string, string>();
	const workingMessages: (string | undefined)[] = [];
	const colors: Record<string, number> = { dim: 90, success: 32, warning: 33, error: 31 };
	t.mock.method(performance, "now", () => now);
	t.mock.method(Date, "now", () => wall);
	t.mock.timers.enable({ apis: ["setInterval"] });

	extension({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
			commands.set(name, command),
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", customType, data: structuredClone(data) }),
	} as unknown as ExtensionAPI);

	const ctx = {
		mode, hasUI: mode === "tui",
		isIdle: () => true,
		model: { id: "fixture-model", provider: "fixture", contextWindow: 128000 },
		getContextUsage: () => ({ contextWindow: 128000, percent: 0 }),
		sessionManager: {
			getEntries: () => entries, getBranch: () => branch,
			getCwd: () => "/fixture/中文", getSessionName: () => undefined,
		},
		ui: {
			notify: (text: string) => notifications.push(text),
			setWorkingMessage: (message?: string) => workingMessages.push(message),
			setFooter: (factory: FooterFactory) => {
				footer?.dispose?.();
				footer = factory(
					{ requestRender: () => { renders++; } } as Parameters<FooterFactory>[0],
					{ fg: (color: string, s: string) => ansi ? `\x1b[${colors[color] ?? 39}m${s}\x1b[39m` : s,
						bold: (s: string) => s } as Parameters<FooterFactory>[1],
					{
						getGitBranch: () => null, getAvailableProviderCount: () => 1,
						getExtensionStatuses: () => statuses, onBranchChange: () => () => {},
					} as Parameters<FooterFactory>[2],
				);
			},
		},
	} as unknown as ExtensionContext;

	const emit = async (name: string, event: Record<string, unknown> = {}) =>
		handlers.get(name)?.({ type: name, ...event }, ctx);
	const message = (output = 0, stopReason = "stop") => ({
		role: "assistant", content: [], stopReason,
		usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	return {
		entries, statuses, ctx, emit,
		commandNames: () => [...commands.keys()],
		useBranch: (selected: Entry[]) => { branch = selected; },
		at: (ms: number) => { now = ms; wall = 1_000_000 + ms; },
		wallAt: (ms: number) => { wall = ms; },
		start: () => emit("message_start", { message: message() }),
		delta: (delta: string, type = "text_delta") => emit("message_update", {
			message: message(), assistantMessageEvent: { type, delta },
		}),
		end: async (output: number, stopReason = "stop") => {
			const m = message(output, stopReason);
			await emit("message_end", { message: m });
			// Pi persists assistant messages after dispatching extension message_end.
			entries.push({ type: "message", message: m });
		},
		render: (width = 200) => footer?.render(width) ?? [],
		renderCount: () => renders,
		workingMessage: () => workingMessages.at(-1),
		workingUpdates: () => workingMessages.length,
		disposeFooter: () => footer?.dispose?.(),
		tick: (ms: number) => t.mock.timers.tick(ms),
		stats: async (args = "") => {
			await commands.get("speed")!.handler(args, ctx);
			return notifications.at(-1)!;
		},
	};
}

test("registers only /speed without legacy command aliases", (t) => {
	const f = fixture(t);
	assert.deepEqual(f.commandNames(), ["speed"]);
});

test("TTFT switches from hourglass to emoji lightning and cumulative time uses TOTAL", async (t) => {
	const f = fixture(t);
	await f.emit("session_start"); await f.emit("agent_start"); await f.start();
	f.at(1500); f.tick(200);
	const waiting = f.render().join("\n");
	assert.match(waiting, /⏳ TTFT 1\.5s…/);
	assert.match(waiting, /🕒 TOTAL 1\.5s/);
	assert.doesNotMatch(waiting, /⚡|Σ/);
	await f.delta("first"); f.at(2500); await f.end(100); await f.emit("agent_settled");
	const completed = f.render().join("\n");
	assert.match(completed, /⚡️ TTFT 1\.5s · 🚄 TPS\(avg\) 100 tok\/s · 🕒 TOTAL 2\.5s/);
	assert.doesNotMatch(completed, /⏳|Σ/);
});

test("metric labels and units are muted while values remain distinct, inline and wrapped", async (t) => {
	const f = fixture(t, [], "tui", true);
	await f.emit("session_start"); await f.emit("agent_start"); await f.start();
	f.at(1000); await f.delta("first");
	f.at(2000); await f.end(100); await f.emit("agent_settled");
	for (const width of [40, 80, 120, 200]) {
		const lines = f.render(width);
		const ansi = lines.join("\n");
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.ok(ansi.includes("\x1b[90mTTFT\x1b[39m 1.0\x1b[90ms\x1b[39m"));
		assert.ok(ansi.includes("\x1b[90mTOTAL\x1b[39m 2.0\x1b[90ms\x1b[39m"));
		assert.ok(ansi.includes("\x1b[90mTPS(avg)\x1b[39m \x1b[33m100\x1b[39m \x1b[90mtok/s\x1b[39m"));
		assert.match(stripVTControlCharacters(ansi), /TTFT.*?TPS\(avg\).*?TOTAL/s);
	}
});

test("whole-reply time uses the native Working label and restores the default when done", async (t) => {
	const f = fixture(t);
	await f.emit("session_start"); await f.emit("before_agent_start");
	assert.equal(f.workingMessage(), "Working… (0.0s)");
	await f.emit("agent_start"); await f.start();
	f.at(1000); await f.delta("first");
	f.at(2000); await f.end(100, "toolUse"); await f.emit("tool_execution_start");
	f.at(5500); f.tick(200);
	assert.equal(f.workingMessage(), "Working… (5.5s)");
	await f.emit("tool_execution_end"); await f.emit("agent_end");
	// A loader recreation during continuation must keep the original reply start.
	f.at(6000); await f.emit("agent_start");
	assert.equal(f.workingMessage(), "Working… (6.0s)");
	f.at(7000); await f.emit("agent_settled");
	assert.equal(f.workingMessage(), undefined);
	const updates = f.workingUpdates();
	f.at(9000); f.tick(1000);
	assert.equal(f.workingUpdates(), updates);
	assert.match(await f.stats(), /Last reply: 7\.0s/);
	assert.doesNotMatch(f.render().join("\n"), /⏱|Working/);
});

test("a first delta at the same instant never renders infinite TPS", async (t) => {
	const f = fixture(t);
	await f.emit("session_start");
	await f.start();
	await f.delta("hello");
	assert.doesNotMatch(f.render().join("\n"), /Infinity|NaN/);
});

test("short streams use monotonic time, including a first delta at time zero", async (t) => {
	const f = fixture(t);
	await f.emit("session_start");
	await f.start();
	await f.delta("a".repeat(40));
	f.at(50);
	f.wallAt(900_000);
	await f.end(10);
	const stats = await f.stats();
	assert.match(stats, /Messages: 1/);
	assert.match(stats, /Last TPS: 200/);
});

test("messages without deltas are counted but do not distort measured TPS", async (t) => {
	const f = fixture(t);
	await f.emit("session_start");
	await f.start(); await f.delta("a".repeat(400));
	f.at(1000); await f.end(100);
	f.at(5000); await f.start();
	f.at(6000); await f.end(900);
	const stats = await f.stats();
	assert.match(stats, /Messages: 2/);
	assert.match(stats, /Output tokens: 1,000/);
	assert.match(stats, /Last TPS: n\/a/);
	assert.match(stats, /Session avg TPS: 100/);
	assert.match(stats, /TPS samples: 1\/2/);
});

test("a whole reply includes tools and continuation, with one frozen round TTFT", async (t) => {
	const f = fixture(t);
	await f.emit("session_start");
	await f.emit("before_agent_start"); await f.emit("agent_start");
	f.at(1000); await f.start();
	f.at(2000); await f.delta("think", "thinking_delta");
	f.at(3000); await f.end(100, "toolUse");
	await f.emit("tool_execution_start");
	f.at(8000); await f.emit("tool_execution_end");
	await f.start();
	f.at(9000); await f.delta("answer");
	f.at(10000); await f.end(100);
	await f.emit("agent_end");
	// agent_end is not final: retries or extensions may continue before settlement.
	f.at(11000); await f.emit("agent_start"); await f.start();
	f.at(12000); await f.delta("more");
	f.at(13000); await f.end(100);
	await f.emit("agent_settled");
	const stats = await f.stats();
	assert.match(stats, /Replies: 1/);
	assert.match(stats, /Last reply: 13\.0s/);
	assert.match(stats, /Last TTFT: 2\.0s/);
	assert.match(stats, /Session reply time: 13\.0s/);
	const footer = f.render().join("\n");
	assert.doesNotMatch(footer, /⏱/);
	assert.match(footer, /⚡️ TTFT 2\.0s/);
	assert.match(footer, /🕒 TOTAL 13\.0s/);
});

test("resume restores timings and TPS without including time between replies", async (t) => {
	const f = fixture(t);
	await f.emit("session_start"); await f.emit("before_agent_start");
	await f.start(); f.at(1000); await f.delta("first");
	f.at(3000); await f.end(100);
	f.at(6000); await f.emit("agent_settled");
	f.at(24_000); await f.emit("session_start", { reason: "resume" });
	assert.match(await f.stats(), /Last reply: 6\.0s/);
	assert.match(await f.stats(), /Last TTFT: 1\.0s/);
	await f.emit("before_agent_start"); await f.start();
	f.at(25_000); await f.delta("second");
	f.at(26_000); await f.end(100); await f.emit("agent_settled");
	const stats = await f.stats();
	assert.match(stats, /Replies: 2/);
	assert.match(stats, /Session reply time: 8\.0s/);
	assert.match(stats, /Session avg TPS: 66\.7/);
	await f.stats("reset");
	await f.emit("session_start", { reason: "reload" });
	assert.match(await f.stats(), /No completed/);
});

test("waiting and tool time refresh live, and render timers stop after settlement", async (t) => {
	const f = fixture(t);
	await f.emit("session_start"); await f.emit("agent_start");
	f.at(1500); f.tick(200);
	assert.match(f.render().join("\n"), /⏳ TTFT 1\.5s…/);
	await f.start(); await f.delta("answer");
	f.at(2500); await f.end(100, "toolUse");
	const before = f.renderCount();
	f.at(10_000); f.tick(200);
	assert.ok(f.renderCount() > before);
	assert.equal(f.workingMessage(), "Working… (10.0s)");
	assert.match(f.render().join("\n"), /⚡️ TTFT 1\.5s/);
	assert.match(f.render().join("\n"), /🕒 TOTAL 10\.0s/);
	await f.emit("agent_settled");
	const settled = f.renderCount();
	f.at(20_000); f.tick(1000);
	assert.equal(f.renderCount(), settled);
	assert.equal(f.workingMessage(), undefined);
});

test("empty deltas do not end the first-token wait; a zero-token abort still has reply time", async (t) => {
	const f = fixture(t);
	await f.emit("session_start"); await f.emit("before_agent_start"); await f.start();
	f.at(1000); await f.delta("");
	assert.match(f.render().join("\n"), /⏳ TTFT 1\.0s…/);
	f.at(3000); await f.end(0, "aborted"); await f.emit("agent_settled");
	const stats = await f.stats();
	assert.match(stats, /Messages: 1/);
	assert.match(stats, /Last reply: 3\.0s/);
	assert.match(stats, /Last TTFT: n\/a/);
	assert.match(stats, /Last outcome: aborted/);
	assert.match(stats, /Session avg TPS: n\/a/);
});

test("error and shutdown record elapsed time, with no double-counting on repeated settlement", async (t) => {
	const f = fixture(t);
	await f.emit("session_start"); await f.emit("agent_start");
	f.at(2000); await f.emit("agent_before_settle", { outcome: "error" });
	await f.emit("agent_settled"); await f.emit("agent_settled");
	assert.match(await f.stats(), /Last outcome: error/);
	f.at(5000); await f.emit("agent_start");
	f.at(8000); await f.emit("session_shutdown");
	const stats = await f.stats();
	assert.match(stats, /Replies: 2/);
	assert.match(stats, /Session reply time: 5\.0s/);
	assert.match(stats, /Last outcome: aborted/);
	const stopped = f.renderCount();
	f.tick(1000);
	assert.equal(f.renderCount(), stopped);
});

test("instant replies and missing usage never produce invalid rates", async (t) => {
	const f = fixture(t);
	await f.emit("session_start"); await f.emit("agent_start"); await f.start();
	await f.delta("first"); await f.end(100); await f.emit("agent_settled");
	assert.match(await f.stats(), /Session avg TPS: n\/a/);
	assert.match(await f.stats(), /Last TTFT: 0\.0s/);
	await f.emit("agent_start"); await f.start(); f.at(1000); await f.delta("second");
	f.at(2000); await f.end(Number.NaN); await f.emit("agent_settled");
	assert.match(await f.stats(), /Output tokens: 100/);
	assert.doesNotMatch(f.render().join("\n"), /Infinity|NaN/);
});

test("live TPS is explicitly approximate, counting Unicode code points", async (t) => {
	const f = fixture(t);
	await f.emit("session_start"); await f.start();
	await f.delta("😀".repeat(40), "toolcall_delta");
	f.at(1000);
	assert.match(f.render().join("\n"), /TPS ≈10\.0 tok\/s/);
	assert.doesNotMatch(f.render().join("\n"), /TPS\(avg\)/);
});

test("tree navigation and fork restore only the selected branch", async (t) => {
	const f = fixture(t);
	await f.emit("session_start"); await f.emit("agent_start");
	await f.start(); f.at(1000); await f.delta("first");
	f.at(3000); await f.end(100); await f.emit("agent_settled");
	const firstBranch = f.entries.slice();
	f.at(10_000); await f.emit("agent_start"); await f.start();
	f.at(11_000); await f.delta("second");
	f.at(15_000); await f.end(100); await f.emit("agent_settled");
	assert.match(await f.stats(), /Replies: 2/);
	f.useBranch(firstBranch); await f.emit("session_tree");
	assert.match(await f.stats(), /Replies: 1/);
	assert.match(await f.stats(), /Session reply time: 3\.0s/);
	await f.emit("session_start", { reason: "fork" });
	assert.match(await f.stats(), /Session avg TPS: 50\.0/);
});

test("unknown or malformed persisted stats cannot corrupt valid history", async (t) => {
	const f = fixture(t);
	await f.emit("session_start"); await f.emit("agent_start"); await f.start();
	await f.delta("first"); f.at(1000); await f.end(100); await f.emit("agent_settled");
	const valid = f.entries.at(-1)!;
	for (const data of [
		null, { version: 99, stats: {} },
		{ version: 1, stats: { messages: Number.NaN } },
		{ ...(valid.data as object), stats: { ...(valid.data as { stats: object }).stats, replyMs: -1 } },
	]) f.entries.push({ type: "custom", customType: valid.customType, data });
	await f.emit("session_start", { reason: "reload" });
	assert.match(await f.stats(), /Session reply time: 1\.0s/);
	assert.match(await f.stats(), /Session avg TPS: 100/);
});

test("reset cannot destroy an active reply, but a new session is isolated", async (t) => {
	const f = fixture(t);
	await f.emit("session_start"); await f.emit("agent_start");
	f.at(1000); assert.match(await f.stats("reset"), /Cannot reset/);
	f.at(2000); await f.emit("agent_settled");
	assert.match(await f.stats(), /Last reply: 2\.0s/);
	f.useBranch([]); await f.emit("session_start", { reason: "new" });
	assert.match(await f.stats(), /No completed/);
	assert.doesNotMatch(f.render().join("\n"), /TTFT|TOTAL/);
});

test("headless mode collects and persists timing without UI render timers", async (t) => {
	const f = fixture(t, [], "json");
	await f.emit("session_start"); await f.emit("agent_start"); await f.start();
	f.at(1000); await f.delta("first"); f.at(2000); await f.end(100);
	await f.emit("agent_settled");
	assert.equal(f.renderCount(), 0);
	assert.equal(f.workingUpdates(), 0);
	assert.match(await f.stats(), /Last reply: 2\.0s/);
	await f.emit("session_start", { reason: "resume" });
	assert.match(await f.stats(), /Last TTFT: 1\.0s/);
});

test("narrow footers retain timing metrics and never exceed terminal width", async (t) => {
	const f = fixture(t);
	f.statuses.set("other", "other extension\nstatus");
	await f.emit("session_start"); await f.emit("agent_start"); await f.start();
	f.at(1000); await f.delta("first"); f.at(72_000); await f.end(100); await f.emit("agent_settled");
	for (const width of [1, 8, 20, 40, 60, 80, 120, 200]) {
		const lines = f.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
		if (width >= 40) {
			assert.doesNotMatch(lines.join("\n"), /⏱/);
			assert.match(lines.join("\n"), /⚡️ TTFT 1\.0s/);
			assert.match(lines.join("\n"), /🕒 TOTAL 1m12s/);
		}
	}
	assert.match(f.render(200).join("\n"), /other extension status/);
});

test("footer metrics are TTFT, TPS, then cumulative reply time at every readable width", async (t) => {
	const f = fixture(t);
	await f.emit("session_start"); await f.emit("agent_start"); await f.start();
	f.at(1000); await f.delta("first");
	f.at(2000); await f.end(100); await f.emit("agent_settled");
	for (const width of [40, 60, 80, 120, 200]) {
		const footer = f.render(width).join("\n");
		assert.match(footer, /TTFT.*?tok\/s.*?TOTAL/s, `wrong metric order at ${width}`);
		assert.doesNotMatch(footer, /⏱|Working/);
	}
});

test("working elapsed time survives footer replacement but stops and restores on shutdown", async (t) => {
	const f = fixture(t);
	await f.emit("session_start"); await f.emit("agent_start");
	f.disposeFooter();
	f.at(5000); f.tick(200);
	assert.equal(f.workingMessage(), "Working… (5.0s)");
	await f.emit("session_shutdown");
	assert.equal(f.workingMessage(), undefined);
	const stopped = f.workingUpdates();
	f.at(10_000); f.tick(1000);
	assert.equal(f.workingUpdates(), stopped);
});

test("session switches restore the native working message and do not retain the old timer", async (t) => {
	const f = fixture(t);
	await f.emit("session_start"); await f.emit("agent_start");
	f.at(2000); f.tick(200);
	assert.equal(f.workingMessage(), "Working… (2.0s)");
	f.useBranch([]); await f.emit("session_start", { reason: "new" });
	assert.equal(f.workingMessage(), undefined);
	const stopped = f.workingUpdates();
	f.at(5000); f.tick(1000);
	assert.equal(f.workingUpdates(), stopped);
	await f.emit("agent_start");
	assert.equal(f.workingMessage(), "Working… (0.0s)");
	f.at(6500); f.tick(200);
	assert.equal(f.workingMessage(), "Working… (1.5s)");
});


