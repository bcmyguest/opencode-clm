/**
 * Drives the real opencode TUI in a pty (Bun.spawn `terminal`, Bun ≥ 1.3.14) for the panel
 * e2e case. Output goes into a headless xterm; `screen()` is the visible text. The project
 * gets a tui.json that loads this checkout's tui.ts. Uses the case's temp HOME/XDG
 * directories (harness.ts), never the user's.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { Terminal } from "@xterm/headless";

import { OPENCODE, type Case } from "./harness.ts";

export const TUI_PLUGIN = `file://${resolve(import.meta.dir, "../../tui.ts")}`;

export class TuiDriver {
	private readonly term: Terminal;
	private readonly proc: ReturnType<typeof Bun.spawn>;

	constructor(c: Case, args: string[], readonly cols = 120, readonly rows = 34) {
		writeFileSync(join(c.project, "tui.json"), JSON.stringify({ plugin: [[TUI_PLUGIN, {}]] }, null, 2));
		this.term = new Terminal({ cols, rows, allowProposedApi: true });
		const term = this.term;
		this.proc = Bun.spawn([OPENCODE, ...args], {
			cwd: c.project,
			env: { ...c.env(), TERM: "xterm-256color" },
			terminal: { cols, rows, data: (_terminal: unknown, data: Uint8Array) => term.write(data) },
		} as never);
	}

	screen(): string {
		const buffer = this.term.buffer.active;
		const lines: string[] = [];
		for (let index = 0; index < this.term.rows; index++) lines.push(buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? "");
		return lines.join("\n");
	}

	async waitFor(pattern: RegExp, ms = 15_000): Promise<boolean> {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (pattern.test(this.screen())) return true;
			await Bun.sleep(150);
		}
		return false;
	}

	async write(data: string, pause = 250): Promise<void> {
		(this.proc as unknown as { terminal: { write(data: string): void } }).terminal.write(data);
		await Bun.sleep(pause);
	}

	async type(text: string): Promise<void> {
		for (const char of text) await this.write(char, 40);
	}

	kill(): void {
		try {
			this.proc.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
}
