// Tests for src/session-files.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPanelModel } from "../../src/panel/model.ts";
import { parseEvents, readSessionFiles, sessionDirectory } from "../../src/session-files.ts";

let parent: string;

beforeEach(async () => {
	parent = await mkdtemp(join(tmpdir(), "clm-panel-"));
});

afterEach(async () => {
	await rm(parent, { recursive: true, force: true });
});

describe("parseEvents", () => {
	test("skips blank, corrupt and non-object lines; an unterminated last line is not counted", () => {
		const text = [
			JSON.stringify({ event: "request", estimated: 1 }),
			"",
			"[1,2]",
			"not json",
			JSON.stringify({ event: "accepted", revision: 1 }),
			'{"event":"request","estim', // torn final append
		].join("\n");
		const parsed = parseEvents(text);
		expect(parsed.events.map((event) => event.event)).toEqual(["request", "accepted"]);
		expect(parsed.skipped).toBe(2);
		expect(parseEvents('not json\n{"event":"request"}\n').skipped).toBe(1);
	});
});

describe("readSessionFiles", () => {
	test("locates the directory like MirrorStore", () => {
		expect(sessionDirectory("/m", "ses/1:x")).toBe("/m/clm-ses-1-x");
	});

	test("a missing directory is not found and not an error", async () => {
		const files = await readSessionFiles(parent, "ses_none");
		expect(files.found).toBe(false);
		expect(files.warnings).toEqual([]);
		expect(buildPanelModel(files).found).toBe(false);
	});

	test("reads every file, tolerating corrupt ones", async () => {
		const directory = sessionDirectory(parent, "ses_1");
		await mkdir(join(directory, "revisions"), { recursive: true });
		await writeFile(join(directory, "events.jsonl"), `${JSON.stringify({ event: "request", estimated: 10, at: "2026-01-01T00:00:00Z" })}\nbroken\n{"torn`);
		await writeFile(join(directory, "state.json"), JSON.stringify({ version: 1, enabled: true, revision: 1 }));
		await writeFile(join(directory, "snapshot.json"), "{ corrupt");
		await writeFile(join(directory, "revisions", "r1.md"), "mirror");
		await writeFile(join(directory, "revisions", "r1.json"), JSON.stringify({ version: 1, revision: 1, rows: [] }));
		await writeFile(join(directory, "revisions", "notes.txt"), "ignored");
		const files = await readSessionFiles(parent, "ses_1");
		expect(files.found).toBe(true);
		expect(files.events.length).toBe(1);
		expect(files.skippedEventLines).toBe(1);
		expect(files.state).toEqual({ version: 1, enabled: true, revision: 1 });
		expect(files.snapshot).toBeUndefined();
		expect(files.warnings.length).toBe(1);
		expect(files.warnings[0]).toContain("snapshot.json is not valid JSON");
		expect([...files.revisions.keys()]).toEqual([1]);
		// rN.md is skipped when rN.json is valid.
		expect(files.revisionTexts.has(1)).toBe(false);
		expect(files.mirrorPath).toBe(join(directory, "LIVE_CONTEXT.md"));
		const model = buildPanelModel(files);
		expect(model.timeline.points.length).toBe(1);
		expect(model.revisions[0]?.traceSource).toBe("recorded");
	});

	test("a v0.1 directory with only events.jsonl", async () => {
		const directory = sessionDirectory(parent, "ses_2");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "events.jsonl"), `${JSON.stringify({ event: "request", estimated: 10 })}\n`);
		const files = await readSessionFiles(parent, "ses_2");
		expect(files).toMatchObject({ found: true, skippedEventLines: 0, warnings: [] });
		expect(files.state).toBeUndefined();
		expect(files.revisions.size).toBe(0);
	});

	test("rN.md is read when rN.json is missing; unchanged revision files come from the cache", async () => {
		const directory = sessionDirectory(parent, "ses_3");
		await mkdir(join(directory, "revisions"), { recursive: true });
		await writeFile(join(directory, "revisions", "r1.md"), "mirror");
		expect((await readSessionFiles(parent, "ses_3")).revisionTexts.get(1)).toBe("mirror");
		await writeFile(join(directory, "revisions", "r2.json"), JSON.stringify({ version: 1, revision: 2, rows: [] }));
		const first = (await readSessionFiles(parent, "ses_3")).revisions.get(2);
		const second = (await readSessionFiles(parent, "ses_3")).revisions.get(2);
		expect(second).toBe(first); // same object: not re-read
	});
});
