// The TUI's session-data source (src/tui/remote.ts): local disk first, else the server's
// file API through a fake client that behaves like opencode 1.18.34's `GET /file` and
// `GET /file/content` (missing file → empty text; text trimmed; missing directory → error).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readSessionDirectory } from "../../src/session-files.ts";
import { channelReader, insideRoot, outsideMessage, remoteReader, resolveSource, sourceOverrides, type ChannelAsk, type FileApi } from "../../src/tui/remote.ts";
import { tempDir } from "../fixtures.ts";

const ROOT = "/srv/project";
const DIR = `${ROOT}/.opencode/clm/clm-ses_remote`;

/** A server file tree keyed by path relative to ROOT. */
function fakeFiles(tree: Record<string, string>): FileApi & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async read({ path }) {
			calls.push(`read ${path}`);
			return { data: { type: "text", content: (tree[path] ?? "").trim() } };
		},
		async list({ path }) {
			calls.push(`list ${path}`);
			const prefix = `${path}/`;
			const names = new Set<string>();
			for (const key of Object.keys(tree)) if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]!);
			if (names.size === 0) return { error: { name: "UnknownError", data: { message: "Path is not a directory" } } };
			return { data: [...names].map((name) => ({ name, path: `${path}/${name}`, type: "file" })) };
		},
	};
}

const rel = DIR.slice(ROOT.length + 1);
const revision = { version: 1, revision: 1, sourceRevision: 0, at: "2026-10-01T00:00:00.000Z", beforeTokens: 10, afterTokens: 5, rows: [] };
const TREE = {
	[`${rel}/events.jsonl`]: `${JSON.stringify({ at: "2026-10-01T00:00:00.000Z", event: "request", request: 1 })}\n${JSON.stringify({ at: "2026-10-01T00:00:01.000Z", event: "accepted", revision: 1 })}\n`,
	[`${rel}/state.json`]: `${JSON.stringify({ version: 1, enabled: true, revision: 1 })}\n`,
	[`${rel}/snapshot.json`]: JSON.stringify({ at: "2026-10-01T00:00:01.000Z", revision: 1 }),
	[`${rel}/overrides.json`]: JSON.stringify({ version: 1, overrides: { budget: 20_000 } }),
	[`${rel}/revisions/r1.json`]: JSON.stringify(revision),
	[`${rel}/revisions/r2.md`]: "# r2\n",
};

describe("remote reader", () => {
	test("reads a session directory through the file API", async () => {
		const files = await readSessionDirectory(DIR, "ses_remote", remoteReader(fakeFiles(TREE), ROOT));
		expect(files.found).toBe(true);
		// The trimmed JSONL loses its final newline; the last line still parses and is not "skipped".
		expect(files.events.map((event) => event.event)).toEqual(["request", "accepted"]);
		expect(files.skippedEventLines).toBe(0);
		expect(files.state).toEqual({ version: 1, enabled: true, revision: 1 });
		expect(files.revisions.get(1)).toEqual(revision);
		expect(files.revisionTexts.get(2)).toBe("# r2");
		expect(files.mirrorPath).toBe(`${DIR}/LIVE_CONTEXT.md`);
		expect(files.warnings).toEqual([]);
	});

	test("a missing directory is not found, without warnings", async () => {
		const files = await readSessionDirectory(`${ROOT}/.opencode/clm/clm-ses_none`, "ses_none", remoteReader(fakeFiles(TREE), ROOT));
		expect([files.found, files.warnings]).toEqual([false, []]);
	});

	test("revision files are read once", async () => {
		const api = fakeFiles({ ...TREE, [`${rel}/revisions/r1.json`]: JSON.stringify({ ...revision, beforeTokens: 11 }) });
		const reader = remoteReader(api, `${ROOT}`);
		await readSessionDirectory(DIR, "ses_remote", { ...reader, name: "remote:cache-test" });
		await readSessionDirectory(DIR, "ses_remote", { ...reader, name: "remote:cache-test" });
		expect(api.calls.filter((call) => call.endsWith("r1.json"))).toHaveLength(1);
	});

	test("a refused read becomes a warning", async () => {
		const api: FileApi = { ...fakeFiles(TREE), read: async () => ({ error: { data: { message: "boom" } } }) };
		const files = await readSessionDirectory(DIR, "ses_remote", remoteReader(api, ROOT));
		expect(files.found).toBe(true);
		expect(files.warnings.join("\n")).toContain("boom");
	});

	test("overrides.json through the API", async () => {
		const source = await resolveSource({ ownDirectory: DIR, serverRoot: ROOT, file: fakeFiles(TREE), locate: async () => undefined, isLocalDirectory: async () => false });
		expect(await sourceOverrides(source)).toEqual({ overrides: { budget: 20_000 } });
		const bad = await resolveSource({ ownDirectory: DIR, serverRoot: ROOT, file: fakeFiles({ ...TREE, [`${rel}/overrides.json`]: "{" }), locate: async () => undefined, isLocalDirectory: async () => false });
		expect((await sourceOverrides(bad)).warning).toContain("not valid JSON");
	});
});

describe("source resolution", () => {
	test("local disk first", async () => {
		const own = tempDir("clm-remote-");
		let located = 0;
		const source = await resolveSource({ ownDirectory: own, serverRoot: ROOT, file: fakeFiles({}), locate: async () => { located++; return undefined; } });
		expect([source.kind, source.directory, located]).toEqual(["local", own, 0]);
		mkdirSync(join(own, "revisions"));
		writeFileSync(join(own, "overrides.json"), JSON.stringify({ version: 1, overrides: { guard: "off" } }));
		expect(await sourceOverrides(source)).toEqual({ overrides: { guard: "off" } });
	});

	test("absent locally: the server's location, read remotely", async () => {
		const source = await resolveSource({
			ownDirectory: "/tui/elsewhere/clm-ses_remote",
			serverRoot: ROOT,
			file: fakeFiles(TREE),
			locate: async () => ({ directory: DIR, root: ROOT }),
			isLocalDirectory: async () => false,
		});
		expect([source.kind, source.directory]).toEqual(["remote", DIR]);
		if (source.kind !== "remote") throw new Error("expected remote");
		expect((await readSessionDirectory(source.directory, "ses_remote", source.reader)).revisions.size).toBe(1);
	});

	test("no answer from the server: this TUI's own path under the server root", async () => {
		const source = await resolveSource({ ownDirectory: DIR, serverRoot: ROOT, file: fakeFiles(TREE), locate: async () => { throw new Error("timeout"); }, isLocalDirectory: async () => false });
		expect([source.kind, source.directory]).toEqual(["remote", DIR]);
	});

	test("outside the server directory: unreadable, with a message", async () => {
		const source = await resolveSource({
			ownDirectory: DIR,
			serverRoot: ROOT,
			file: fakeFiles(TREE),
			locate: async () => ({ directory: "/var/clm/clm-ses_remote", root: ROOT }),
			isLocalDirectory: async () => false,
		});
		expect(source).toEqual({ kind: "outside", directory: "/var/clm/clm-ses_remote", root: ROOT });
		expect(outsideMessage({ directory: "/var/clm/clm-ses_remote", root: ROOT })).toContain("outside the server's directory /srv/project");
		expect(await sourceOverrides(source)).toEqual({ overrides: {} });
	});

	test("outside the server directory with the server plugin answering: read over the channel", async () => {
		// The server's session directory, as the channel's read/list operations see it.
		const tree: Record<string, string> = Object.fromEntries(Object.entries(TREE).map(([key, value]) => [key.slice(rel.length + 1), value]));
		const asked: string[] = [];
		const ask: ChannelAsk = async (operation) => {
			asked.push(`${operation.op} ${operation.path}`);
			if (operation.op === "read") return tree[operation.path] !== undefined ? { content: tree[operation.path] } : {};
			const prefix = operation.path === "" ? "" : `${operation.path}/`;
			const names = [...new Set(Object.keys(tree).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length).split("/")[0]!))];
			return names.length > 0 ? { names } : {};
		};
		const outside = "/var/clm/clm-ses_remote";
		const source = await resolveSource({ ownDirectory: DIR, serverRoot: ROOT, file: fakeFiles({}), locate: async () => ({ directory: outside, root: ROOT }), ask, isLocalDirectory: async () => false });
		expect(source.kind).toBe("channel");
		if (source.kind !== "channel") throw new Error("expected channel");
		const files = await readSessionDirectory(source.directory, "ses_remote", source.reader);
		expect([files.found, files.events.length, files.revisions.size, files.revisionTexts.get(2), files.warnings]).toEqual([true, 2, 1, "# r2\n", []]);
		expect(await sourceOverrides(source)).toEqual({ overrides: { budget: 20_000 } });
		expect(asked).toContain("list ");
		expect(asked).toContain("read revisions/r1.json");
		await expect(channelReader(ask, outside).readText("/etc/passwd")).rejects.toThrow("outside the session directory");
	});

	test("insideRoot", () => {
		expect(insideRoot(ROOT, DIR)).toBe(rel);
		expect(insideRoot(ROOT, ROOT)).toBe(".");
		expect(insideRoot(ROOT, "/srv/project-other/x")).toBeUndefined();
		expect(insideRoot(ROOT, "/srv")).toBeUndefined();
		expect(insideRoot(ROOT, `${ROOT}/..x/y`)).toBe("..x/y");
	});

	test("same disk, session not started: local at once, locate in the background", async () => {
		const local = new Set(["/srv/project", "/srv/project/.opencode/clm"]);
		let asked = 0;
		let relocated = 0;
		const deps = {
			ownDirectory: DIR,
			serverRoot: ROOT,
			file: fakeFiles(TREE),
			locate: async () => { asked++; return undefined; },
			relocate: () => { relocated++; },
			isLocalDirectory: async (path: string) => local.has(path),
		};
		expect((await resolveSource(deps)).kind).toBe("local");
		expect([asked, relocated]).toEqual([0, 1]);
		// With a cached answer, that answer decides.
		const elsewhere = await resolveSource({ ...deps, located: () => ({ directory: DIR, root: ROOT }), locate: async () => ({ directory: DIR, root: ROOT }) });
		expect(elsewhere.kind).toBe("remote");
		// Another host (the server directory is not here): ask and wait, as before.
		local.delete("/srv/project");
		expect((await resolveSource(deps)).kind).toBe("remote");
		expect(asked).toBe(1);
	});
});

describe("revision cache over a constant stamp", () => {
	test("a restarted revision count drops the cached rN files", async () => {
		const tree: Record<string, string> = { ...TREE, [`${rel}/state.json`]: JSON.stringify({ version: 1, enabled: true, revision: 5 }) };
		const reader = { ...remoteReader(fakeFiles(tree), ROOT), name: "remote:restart-test" };
		expect((await readSessionDirectory(DIR, "ses_remote", reader)).revisions.get(1)).toEqual(revision);
		// state.json was corrupt: the session started over, and its new r1 replaced the old one.
		tree[`${rel}/state.json`] = JSON.stringify({ version: 1, enabled: true, revision: 1 });
		tree[`${rel}/revisions/r1.json`] = JSON.stringify({ ...revision, beforeTokens: 99 });
		expect((await readSessionDirectory(DIR, "ses_remote", reader)).revisions.get(1)).toMatchObject({ beforeTokens: 99 });
		// Same revision again: served from the cache.
		tree[`${rel}/revisions/r1.json`] = JSON.stringify({ ...revision, beforeTokens: 7 });
		expect((await readSessionDirectory(DIR, "ses_remote", reader)).revisions.get(1)).toMatchObject({ beforeTokens: 99 });
	});

	test("write mode skips the same-disk guess and goes where the server keeps the files", async () => {
		const local = new Set(["/srv/project", "/srv/project/.opencode/clm"]);
		const own = `${ROOT}/.opencode/clm/clm-ses_remote_tui`;
		let relocated = 0;
		const deps = (answer: { directory: string; root: string } | undefined) => ({
			ownDirectory: own,
			serverRoot: ROOT,
			file: fakeFiles(TREE),
			locate: async () => answer,
			relocate: () => { relocated++; },
			isLocalDirectory: async (path: string) => local.has(path),
		});
		// Reads still take the shortcut.
		expect((await resolveSource(deps({ directory: DIR, root: ROOT }))).kind).toBe("local");
		expect(relocated).toBe(1);
		// A write asks and follows the server's answer.
		const write = await resolveSource(deps({ directory: DIR, root: ROOT }), { write: true });
		expect([write.kind, write.directory]).toEqual(["remote", DIR]);
		expect(relocated).toBe(1);
		// The server names this TUI's own directory, or does not answer on its own disk: local.
		expect((await resolveSource(deps({ directory: own, root: ROOT }), { write: true })).kind).toBe("local");
		expect((await resolveSource(deps(undefined), { write: true })).kind).toBe("local");
		// No answer and not the server's disk: not local.
		local.delete("/srv/project");
		expect((await resolveSource(deps(undefined), { write: true })).kind).toBe("remote");
	});
});
