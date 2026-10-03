/**
 * Captures the README screenshots (.github/images/{overview,edits,settings}.png) from the real
 * opencode TUI with both plugins loaded, driven against the e2e mock server (test/e2e). No
 * model, no network after the first start, temp HOME/XDG directories like the e2e suite.
 *
 * The pty byte stream is replayed into real xterm.js in headless Chromium (Playwright) and
 * the terminal element is screenshotted. Neither package is a dependency of this repo; see
 * docs/development.md "Reproducing the screenshots" for the commands.
 *
 *   SHOTS_DEPS=<dir with node_modules/@xterm/xterm and playwright-core> \
 *   OPENCODE_BIN=~/.opencode/bin/opencode bun scripts/screenshots.ts
 */
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { Terminal } from "@xterm/headless";

import { Case, cleanup, mirrorEdit, OPENCODE } from "../test/e2e/harness.ts";
import { bash, steps, text, type RecordedRequest, type Reply, type Step } from "../test/e2e/mock-server.ts";
import { TUI_PLUGIN } from "../test/e2e/tui-driver.ts";

const REPO = resolve(import.meta.dir, "..");
const OUT = join(REPO, ".github/images");
const DEPS = resolve(process.env.SHOTS_DEPS ?? "/tmp/oc-shots-deps");
const COLS = 120;
const ROWS = 34;
const DEBUG = process.env.SHOTS_DEBUG === "1";

/** Provider usage the mock reports: the request's characters / 4, as a real server would count roughly. */
function sized(step: (request: RecordedRequest) => Reply): (request: RecordedRequest) => Reply {
	return (request) => {
		const reply = step(request);
		const prompt = Math.round(JSON.stringify(request.messages).length / 4);
		return { ...reply, usage: { prompt_tokens: prompt, completion_tokens: 60 } };
	};
}

/** Replace the mirror block holding `needle` with `note`. */
function compact(edits: [needle: string, note: string][], answer: string): Step[] {
	return [
		sized((request) => bash(
			edits.map(([needle, note]) => mirrorEdit(request.mirrorPath!, JSON.stringify(needle), "replace", JSON.stringify(note))).join("\n"),
			"Compact the live context",
		)),
		sized(() => text(answer)),
	];
}

const script = steps(
	// Turn 1: read two long files.
	sized(() => bash("cat src/settings-table.ts", "Read the settings table")),
	sized(() => bash("cat src/budget.ts", "Read the budget code")),
	sized(() => text("Settings live in src/settings-table.ts (one row per setting: name, default, env variable); src/budget.ts parses budget values such as 32k and 75%.")),
	// /clm-compact 1.
	...compact(
		[["export type SettingKey", "[note: src/settings-table.ts — one row per setting (name, values, default, env); read for the settings table]"],
			["export function resolveBudgetPolicy", "[note: src/budget.ts — parses 32k / 75% budgets; formatTokens for display]"]],
		"Kept the two file summaries; dropped the raw listings. Now about 3k tokens.",
	),
	// Turn 2: two more long files.
	sized(() => bash("cat src/panel/view.ts", "Read the panel view")),
	sized(() => bash("cat src/panel/timeline.ts", "Read the timeline")),
	sized(() => text("The overview chart comes from src/panel/timeline.ts (one column per request, edit markers); src/panel/view.ts lays out the four pages.")),
	// /clm-compact 2.
	...compact(
		[["function overviewLines", "[note: src/panel/view.ts — renders overview, input, edits and settings pages]"],
			["export function formatTokenCount", "[note: src/panel/timeline.ts — context-size chart: points, markers, zoom fit/requests/turns]"]],
		"Kept the page and chart summaries; dropped both listings. Now about 3k tokens.",
	),
);

class Pty {
	readonly term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
	readonly bytes: Uint8Array[] = [];
	private readonly proc: ReturnType<typeof Bun.spawn>;

	constructor(c: Case, args: string[]) {
		writeFileSync(join(c.project, "tui.json"), JSON.stringify({ plugin: [[TUI_PLUGIN, {}]] }, null, 2));
		this.proc = Bun.spawn([OPENCODE, ...args], {
			cwd: c.project,
			env: { ...c.env(), TERM: "xterm-256color", COLORTERM: "truecolor" },
			terminal: {
				cols: COLS,
				rows: ROWS,
				data: (_t: unknown, data: Uint8Array) => {
					this.bytes.push(data.slice());
					this.term.write(data);
				},
			},
		} as never);
	}

	screen(): string {
		const buffer = this.term.buffer.active;
		const lines: string[] = [];
		for (let i = 0; i < ROWS; i++) lines.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "");
		return lines.join("\n");
	}

	async waitFor(pattern: RegExp, ms = 15_000): Promise<void> {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (pattern.test(this.screen())) return;
			await Bun.sleep(150);
		}
		throw new Error(`timed out waiting for ${pattern}\n${this.screen()}`);
	}

	async write(data: string, pause = 300): Promise<void> {
		(this.proc as unknown as { terminal: { write(d: string): void } }).terminal.write(data);
		await Bun.sleep(pause);
	}

	async type(value: string): Promise<void> {
		for (const char of value) await this.write(char, 40);
	}

	/** Enter a slash command: type, wait for the autocomplete to settle, Enter. */
	async command(value: string): Promise<void> {
		await this.type(value);
		await Bun.sleep(300);
		await this.write("\r", 1_000);
	}

	kill(): void {
		try {
			this.proc.kill("SIGKILL");
		} catch {
			// gone
		}
	}
}

/** Selected row of the current page (the line starting with the selection marker). */
function selected(screen: string): string {
	return screen.split("\n").find((line) => /› [▸▾] /.test(line)) ?? "";
}

/** The slice of playwright-core's Page used here (the package lives outside this repo). */
interface Page {
	evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
	locator(selector: string): { screenshot(options: { path: string }): Promise<unknown> };
}

async function render(page: Page, pty: Pty, name: string): Promise<void> {
	await Bun.sleep(1_000);
	const all = Buffer.concat(pty.bytes);
	if (DEBUG) writeFileSync(`/tmp/shot-${name}.txt`, pty.screen());
	await page.evaluate(async (b64: string) => {
		const w = window as unknown as { term: any };
		w.term.reset();
		const data = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
		await new Promise<void>((done) => w.term.write(data, done));
		w.term.blur();
	}, all.toString("base64"));
	await Bun.sleep(300);
	await page.locator("#t").screenshot({ path: join(OUT, `${name}.png`) });
	console.log(`wrote ${join(OUT, `${name}.png`)}`);
}

async function main(): Promise<void> {
	const { chromium } = await import(join(DEPS, "node_modules/playwright-core/index.mjs"));
	const c = new Case("screenshots", script, {
		plugin: { budget: "32k" },
		config: { compaction: { auto: false } },
		limit: { context: 128_000, output: 8_192 },
	});
	try {
		await capture(c, chromium);
	} finally {
		cleanup();
	}
}

async function capture(c: Case, chromium: any): Promise<void> {
	cpSync(join(REPO, "src"), join(c.project, "src"), { recursive: true });

	await c.run(["Read src/settings-table.ts and src/budget.ts and tell me where the settings live."]);
	await c.run(["--session", c.sessionID(), "--command", "clm-compact", "keep one line per file"]);
	await c.run(["--session", c.sessionID(), "Now read src/panel/view.ts and src/panel/timeline.ts: where does the overview chart come from?"]);
	await c.run(["--session", c.sessionID(), "--command", "clm-compact", "keep one line per file"]);
	const revision = c.stateJson().revision;
	if (revision !== 2) throw new Error(`expected revision 2, got ${revision}: ${JSON.stringify(c.stateJson()).slice(0, 400)}`);

	mkdirSync(OUT, { recursive: true });
	const browser = await chromium.launch({ channel: "chromium" });
	const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1600, height: 1000 } });
	await page.setContent(`<!doctype html><html><head><style>body{margin:0;background:#000}#t{display:inline-block}</style></head><body><div id="t"></div></body></html>`);
	await page.addStyleTag({ path: join(DEPS, "node_modules/@xterm/xterm/css/xterm.css") });
	await page.addScriptTag({ path: join(DEPS, "node_modules/@xterm/xterm/lib/xterm.js") });
	await page.evaluate(([cols, rows]: number[]) => {
		const w = window as unknown as { Terminal: any; term: any };
		w.term = new w.Terminal({
			cols,
			rows,
			fontFamily: "'FiraCode Nerd Font Mono', 'DejaVu Sans Mono', monospace",
			fontSize: 14,
			allowProposedApi: true,
			cursorBlink: false,
			cursorInactiveStyle: "none",
		});
		w.term.open(document.getElementById("t"));
	}, [COLS, ROWS]);
	await page.evaluate(() => document.fonts.ready);

	const pty = new Pty(c, ["-s", c.sessionID()]);
	try {
		await pty.waitFor(/Now about 3k tokens/, 60_000);
		await Bun.sleep(1_500);

		// overview.png: newest edit row selected.
		await pty.command("/clm");
		await pty.waitFor(/Live Context Viewer · r2/);
		for (let i = 0; i < 40 && !/Enter: before\/after in edits/.test(pty.screen()); i++) await pty.write("\x1b[D", 200);
		await pty.waitFor(/Enter: before\/after in edits/);
		await render(page, pty, "overview");

		// edits.png: first `~` row of the newest revision, expanded.
		await pty.write("3");
		await pty.waitFor(/Live-context compression runs/);
		for (let i = 0; i < 30 && !/~/.test(selected(pty.screen())); i++) await pty.write("j", 200);
		if (!/~/.test(selected(pty.screen()))) throw new Error(`no ~ row selected\n${pty.screen()}`);
		await pty.write("\r", 800);
		await render(page, pty, "edits");

		// settings.png: one changed row, settings page.
		await pty.write("q", 800);
		await pty.waitFor(/Now about 3k tokens/);
		await pty.command("/clm config reminders 50/75/90%");
		await pty.waitFor(/Reminders: 50\/75\/90%/i);
		await Bun.sleep(4_000);
		await pty.command("/clm config");
		await pty.waitFor(/› CLM editing/);
		await render(page, pty, "settings");
	} finally {
		pty.kill();
		await browser.close();
	}
}

await main();
