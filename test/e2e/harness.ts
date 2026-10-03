/**
 * Harness for the integration tests: real `opencode` (OPENCODE_BIN, default `opencode`)
 * in temp HOME/XDG directories against the scripted mock in mock-server.ts.
 *
 * Shared across cases (created once per test process): HOME (npm cache) and
 * XDG_CONFIG_HOME / XDG_CACHE_HOME. opencode npm-installs `@opencode-ai/plugin` into
 * `$XDG_CONFIG_HOME/opencode/node_modules` on first start; later cases reuse it. Nothing
 * case-specific lives there: each case's opencode.json sits in its own project directory.
 * Per case: project dir, XDG_DATA_HOME (session database), XDG_STATE_HOME, mirror dir,
 * mock server.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { MODEL_ID, startMockServer, textOf, type ChatMessage, type MockServer, type RecordedRequest, type Script } from "./mock-server.ts";

export const ENABLED = process.env.OPENCODE_CLM_E2E === "1";
export const OPENCODE = process.env.OPENCODE_BIN ?? "opencode";
export const PLUGIN = `file://${resolve(import.meta.dir, "../../index.ts")}`;
export const SKILLS_DIR = resolve(import.meta.dir, "../../skills");
export const RUN_TIMEOUT_MS = 150_000;
/** Per-test timeout for cases with up to two opencode runs. */
export const CASE_TIMEOUT_MS = 2 * RUN_TIMEOUT_MS + 30_000;

let root = "";
const mocks: MockServer[] = [];
/** Stops for every `opencode serve` started. */
const servers: Array<() => void> = [];

/** A path under the shared temp root (created lazily). */
export function tempPath(name: string): string {
	shared();
	return join(root, name);
}

function shared() {
	if (!root) root = mkdtempSync(join(tmpdir(), "opencode-clm-e2e-"));
	const d = { home: join(root, "home"), config: join(root, "xdg-config"), cache: join(root, "xdg-cache") };
	for (const path of Object.values(d)) mkdirSync(path, { recursive: true });
	return d;
}

/** Stop every mock and remove the temp tree (kept with OPENCODE_CLM_E2E_KEEP=1). */
export function cleanup(): void {
	for (const stop of servers) stop();
	for (const mock of mocks) mock.stop();
	if (root && !process.env.OPENCODE_CLM_E2E_KEEP) rmSync(root, { recursive: true, force: true });
	else if (root) console.warn(`kept ${root}`);
}

export interface RunResult {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	ms: number;
}

export interface CaseOptions {
	/** Plugin options merged over `{ mirrorDir }`. */
	plugin?: Record<string, unknown>;
	/** Top-level opencode.json keys merged over the defaults. */
	config?: Record<string, unknown>;
	/** Model limits for the mock model. */
	limit?: { context: number; output: number };
	/** Leave OpenCode's auto-compaction on (it is off by default here). */
	autocompact?: boolean;
	/** Omit the plugin from opencode.json (control runs). */
	withoutPlugin?: boolean;
	/**
	 * Name the mirror dir only in the server processes' CLM_MIRROR_DIR, not in the plugin
	 * options, so a TUI with its own CLM_MIRROR_DIR resolves a different, absent directory
	 * (attach tests). `inside`: `<project>/.opencode/clm-server`, readable through OpenCode's
	 * file API; `outside`: the usual per-case mirror dir outside the project.
	 */
	mirrorViaServerEnv?: "inside" | "outside";
}

/** A running `opencode serve`. */
/** A running `opencode serve` (Case.serve). */
export interface Served {
	url: string;
	stop(): void;
	/** JSON request against the server, scoped to the case's project directory. */
	request(method: string, path: string, body?: unknown): Promise<any>;
}

export class Case {
	readonly project: string;
	readonly data: string;
	readonly state: string;
	readonly mirror: string;
	readonly mock: MockServer;
	readonly runs: RunResult[] = [];

	constructor(readonly name: string, script: Script, readonly options: CaseOptions = {}) {
		shared();
		const base = join(root, name);
		this.project = join(base, "project");
		this.data = join(base, "xdg-data");
		this.state = join(base, "xdg-state");
		this.mirror = options.mirrorViaServerEnv === "inside" ? join(this.project, ".opencode", "clm-server") : join(base, "mirror");
		for (const path of [this.project, this.data, this.state, this.mirror]) mkdirSync(path, { recursive: true });
		this.mock = startMockServer(script);
		mocks.push(this.mock);
		this.writeConfig();
	}

	private writeConfig(): void {
		const o = this.options;
		const config = {
			$schema: "https://opencode.ai/config.json",
			model: `mock/${MODEL_ID}`,
			small_model: `mock/${MODEL_ID}`,
			autoupdate: false,
			share: "disabled",
			permission: { bash: "allow", edit: "allow", external_directory: "allow" },
			provider: {
				mock: {
					npm: "@ai-sdk/openai-compatible",
					name: "CLM e2e mock",
					options: { baseURL: this.mock.url, apiKey: "e2e" },
					models: { [MODEL_ID]: { name: "mock", tool_call: true, limit: o.limit ?? { context: 32000, output: 2048 } } },
				},
			},
			...(o.withoutPlugin ? {} : { plugin: [[PLUGIN, { ...(o.mirrorViaServerEnv ? {} : { mirrorDir: this.mirror }), ...(o.plugin ?? {}) }]] }),
			...(o.config ?? {}),
		};
		writeFileSync(join(this.project, "opencode.json"), JSON.stringify(config, null, 2));
	}

	env(): Record<string, string> {
		const s = shared();
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			// Network settings for opencode's npm install of @opencode-ai/plugin.
			...Object.fromEntries(
				["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NPM_CONFIG_REGISTRY", "npm_config_registry"]
					.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])),
			),
			HOME: s.home,
			XDG_CONFIG_HOME: s.config,
			XDG_CACHE_HOME: s.cache,
			XDG_DATA_HOME: this.data,
			XDG_STATE_HOME: this.state,
			TERM: "dumb",
			OPENCODE_DISABLE_AUTOUPDATE: "1",
			OPENCODE_DISABLE_MODELS_FETCH: "1",
			OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
			OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
			OPENCODE_DISABLE_SHARE: "1",
			OPENCODE_DISABLE_CLAUDE_CODE: "1",
			OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
		};
		// The env flag overrides the config, so it is set only when compaction must stay off.
		if (!this.options.autocompact) env.OPENCODE_DISABLE_AUTOCOMPACT = "1";
		if (this.options.mirrorViaServerEnv) env.CLM_MIRROR_DIR = this.mirror;
		return env;
	}

	/** `opencode <args>` in the project directory, in its own process group. */
	async exec(args: string[]): Promise<RunResult> {
		const started = performance.now();
		const child = Bun.spawn([OPENCODE, ...args], {
			cwd: this.project,
			env: this.env(),
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			detached: true,
		});
		const killGroup = () => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// group already gone
			}
		};
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
		}, RUN_TIMEOUT_MS);
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		try {
			const code = await child.exited;
			// A surviving grandchild could hold the pipes open; kill the group, then bound the reads.
			killGroup();
			const drained = (value: Promise<string>) => Promise.race([value, Bun.sleep(5_000).then(() => "<pipe still open after 5 s>")]);
			return { stdout: await drained(stdout), stderr: await drained(stderr), code, timedOut, ms: Math.round(performance.now() - started) };
		} finally {
			clearTimeout(timer);
			killGroup();
		}
	}

	/**
	 * `opencode serve` in the project directory on a free loopback port; resolves once it
	 * listens. `stop()` kills its process group; `request` calls the HTTP API with the
	 * project as `directory`.
	 */
	async serve(): Promise<Served> {
		const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
		const port = probe.port;
		probe.stop(true);
		const child = Bun.spawn([OPENCODE, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
			cwd: this.project,
			env: this.env(),
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			detached: true,
		});
		const stop = () => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// group already gone
			}
		};
		servers.push(stop);
		void new Response(child.stderr).text().catch(() => undefined);
		const decoder = new TextDecoder();
		let output = "";
		// One read loop for the server's life: it finds the URL, then keeps the pipe drained.
		const url = new Promise<string | undefined>((resolve) => {
			void (async () => {
				const reader = child.stdout.getReader();
				for (;;) {
					const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
					if (chunk.done) break;
					output += decoder.decode(chunk.value);
					const match = output.match(/listening on (http:\/\/\S+)/);
					if (match) resolve(match[1]);
				}
				resolve(undefined);
			})();
		});
		const found = await Promise.race([url, Bun.sleep(RUN_TIMEOUT_MS).then(() => undefined)]);
		const project = this.project;
		if (found) return {
			url: found,
			stop,
			async request(method: string, path: string, body?: unknown): Promise<any> {
				const url = new URL(path, found);
				url.searchParams.set("directory", project);
				const response = await fetch(url, {
					method,
					headers: { "content-type": "application/json" },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
					signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
				});
				const text = await response.text();
				if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 500)}`);
				return text ? JSON.parse(text) : undefined;
			},
		};
		stop();
		throw new Error(`e2e ${this.name}: opencode serve did not start; stdout:\n${output.slice(-2000)}`);
	}

	/**
	 * `opencode run --model mock/... --print-logs <args>`. Fails with the reason and stderr
	 * tail when no request carried the CLM system prompt, or when opencode did not exit 0.
	 */
	async run(args: string[], options: { expectMain?: boolean } = {}): Promise<RunResult> {
		const before = this.mock.main().length;
		const result = await this.exec(["run", "--model", `mock/${MODEL_ID}`, "--print-logs", ...args]);
		this.runs.push(result);
		const how = result.timedOut ? `timed out after ${RUN_TIMEOUT_MS / 1000}s` : `exited ${result.code}`;
		if ((options.expectMain ?? true) && this.mock.main().length === before) {
			const total = this.mock.requests.length;
			const reason = total > 0
				? `opencode ${how}; no request carried the CLM system prompt: the plugin did not load or did not run`
				: `opencode ${how} without calling the mock`;
			const network = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|registry\.npmjs|npm (ERR|install)|bun (add|install)|network/i.test(result.stderr);
			console.warn(`E2E FAILURE (${this.name}): ${reason}${network ? " (the npm install of @opencode-ai/plugin may lack network)" : ""}\n${result.stderr.slice(-3000)}`);
			throw new Error(`e2e ${this.name}: ${reason}`);
		}
		if (result.timedOut || result.code !== 0) {
			console.warn(`opencode stderr tail (${this.name}):\n${result.stderr.slice(-4000)}`);
			throw new Error(`e2e ${this.name}: opencode ${how}`);
		}
		return result;
	}

	/** Every `clm-<session id>` directory under the mirror dir. */
	sessionDirs(): string[] {
		return readdirSync(this.mirror).filter((name) => name.startsWith("clm-")).map((name) => join(this.mirror, name));
	}

	/** The single `clm-<session id>` directory under the mirror dir. */
	sessionDir(): string {
		const sessions = readdirSync(this.mirror).filter((name) => name.startsWith("clm-"));
		if (sessions.length !== 1) throw new Error(`expected one CLM session dir, found ${JSON.stringify(sessions)}`);
		return join(this.mirror, sessions[0]!);
	}

	sessionID(): string {
		return this.sessionDir().split("/").pop()!.slice("clm-".length);
	}

	stateJson(): any {
		return JSON.parse(readFileSync(join(this.sessionDir(), "state.json"), "utf8"));
	}

	events(): any[] {
		const path = join(this.sessionDir(), "events.jsonl");
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	}

	mirrorText(): string {
		return readFileSync(join(this.sessionDir(), "LIVE_CONTEXT.md"), "utf8");
	}
}

// ---- request inspection ----------------------------------------------------------------

export function contentText(message: ChatMessage): string {
	return typeof message.content === "string" ? message.content : textOf(message.content);
}

export function toolTexts(request: RecordedRequest): string[] {
	return request.messages.filter((m) => m.role === "tool").map(contentText);
}

export function userTexts(request: RecordedRequest): string[] {
	return request.messages.filter((m) => m.role === "user").map(contentText);
}

/** Everything the model receives as conversation (system prompt excluded). */
export function conversation(request: RecordedRequest): string {
	return JSON.stringify(request.messages.filter((m) => m.role !== "system"));
}

/** The `revision=N` on line 1 of a mirror text. */
export function mirrorRevision(mirror: string | undefined): number | undefined {
	const match = mirror?.match(/^\[\[LIVE_CONTEXT [^\n]*?revision=(\d+)/);
	return match ? Number(match[1]) : undefined;
}

// ---- scripted edits ------------------------------------------------------------------

/**
 * A bash command (python3) that edits the mirror block whose body holds `findPy`, the way the
 * clm-context skill teaches (blocks located by the document id from line 1). `findPy` and
 * `withPy` are python expressions, so test literals can be built by concatenation and never
 * appear verbatim in the command text the next request carries.
 *   replace: the block body becomes `withPy`;
 *   append:  `withPy` is appended to the block body.
 */
export function mirrorEdit(mirror: string, findPy: string, mode: "replace" | "append", withPy: string): string {
	const edit = mode === "replace"
		? `text = text[:h.end()] + "\\n" + new + "\\n\\n" + text[stop:]`
		: `text = text[:stop].rstrip("\\n") + "\\n" + new + "\\n\\n" + text[stop:]`;
	return `python3 - "${mirror}" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
doc = re.match(r"\\[\\[LIVE_CONTEXT .*?document=([a-f0-9]{64})", text).group(1)
needle = ${findPy}
new = ${withPy}
head = re.compile(r"^\\[\\[CTX_TURN document=" + doc + r" [^\\n]*\\]\\]$", re.M)
heads = list(head.finditer(text))
for i, h in enumerate(heads):
    stop = heads[i + 1].start() if i + 1 < len(heads) else len(text)
    if needle in text[h.end():stop]:
        ${edit}
        break
else:
    raise SystemExit("block not found")
open(path, "w").write(text)
print("edited")
PY`;
}
