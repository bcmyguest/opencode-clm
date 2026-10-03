// Adapted from pi-clm src/__tests__/overflow.test.ts (MIT, Copyright 2026 Emanuel Casco).
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capObservations, resolveObservationCap } from "../src/observation.ts";
import {
	DEFAULT_OVERFLOW_GUARD,
	WITHHELD_NOTE_PREFIX,
	applyOverflowGuard,
	overflowGuardLimit,
	overflowNoticeText,
	resolveOverflowGuard,
	withheldFileName,
	withheldNoteText,
} from "../src/overflow.ts";
import type { LiveContextMessage } from "../src/types.ts";

const estimate = (messages: LiveContextMessage[]) =>
	messages.reduce((sum, m) => sum + Math.ceil(JSON.stringify(m.content ?? "").length / 4), 0);
/** Flattened OpenCode tool result, as opencode.ts `flatten` emits it. */
const tool = (id: string, chars: number, name = "read"): LiveContextMessage => ({
	role: "toolResult", toolCallId: id, toolName: name, isError: false, ocMessageID: "msg_a", timestamp: 1,
	content: [{ type: "text", text: "x".repeat(chars) }],
});
const user: LiveContextMessage = { role: "user", content: "task", ocMessageID: "msg_u", timestamp: 0 };
const noteText = (message: LiveContextMessage) => (message.content as { text: string }[])[0]!.text;

describe("overflow guard", () => {
	test("limit is budget minus reserve, at least 1; withhold is the default mode", () => {
		expect(overflowGuardLimit(28_000, 2048)).toBe(25_952);
		expect(overflowGuardLimit(1000, 5000)).toBe(1);
		expect(DEFAULT_OVERFLOW_GUARD.mode).toBe("withhold");
		expect(resolveOverflowGuard(undefined)).toEqual({ mode: "withhold" });
		expect(resolveOverflowGuard({ mode: "off" })).toEqual({ mode: "off" });
	});

	test("does nothing under the limit; withholds oldest tool results first until it fits", () => {
		const messages = [user, tool("a", 4000), tool("b", 4000), tool("c", 4000)];
		const under = applyOverflowGuard(messages, { limit: 10_000, fixedTokens: 0, estimate });
		expect(under.messages).toBe(messages);
		expect(under.withheld).toHaveLength(0);
		const over = applyOverflowGuard(messages, { limit: 1_100, fixedTokens: 0, estimate });
		expect(over.withheld.map((w) => w.toolCallId)).toEqual(["a", "b"]);
		expect(over.messages[3]).toBe(messages[3]!); // the newest result stays
		expect(noteText(over.messages[1]!)).toMatch(/^\[clm overflow guard\] read#a \(~1,00\d tok\) withheld over budget\. Full text remains in the session history\.$/);
		expect(noteText(over.messages[1]!).length).toBeLessThan(200);
		expect(over.estimated).toBeLessThanOrEqual(1_100);
		// The note keeps role, call id and OpenCode message id, and is flagged for unflatten.
		expect(over.messages[1]!.role).toBe("toolResult");
		expect(over.messages[1]!.toolCallId).toBe("a");
		expect(over.messages[1]!.ocMessageID).toBe("msg_a");
		expect(over.messages[1]!.withheld).toBe(true);
		expect(messages[1]!.withheld).toBeUndefined(); // source untouched
		expect(over.messages[0]).toBe(user);
	});

	test("fixedTokens counts toward the limit", () => {
		const messages = [user, tool("a", 400)];
		expect(applyOverflowGuard(messages, { limit: 200, fixedTokens: 0, estimate }).withheld).toHaveLength(0);
		const result = applyOverflowGuard(messages, { limit: 200, fixedTokens: 150, estimate });
		expect(result.withheld.map((w) => w.toolCallId)).toEqual(["a"]);
		expect(result.estimated).toBe(150 + estimate(result.messages));
	});

	test("respects protectBefore, is idempotent, and saves the full text to a file", () => {
		const dir = join(mkdtempSync(join(tmpdir(), "clm-overflow-")), "withheld");
		const messages = [user, tool("old", 4000), tool("new", 4000)];
		const result = applyOverflowGuard(messages, { limit: 1_200, fixedTokens: 0, estimate, saveDirectory: dir, protectBefore: 2 });
		expect(result.withheld.map((w) => w.toolCallId)).toEqual(["new"]); // the protected prefix is never withheld
		expect(result.estimated).toBeLessThanOrEqual(1_200);
		expect(result.messages[1]).toBe(messages[1]!);
		const file = result.withheld[0]!.file!;
		expect(file).toBe(join(dir, "msg_a-new.txt"));
		expect(existsSync(file)).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("x".repeat(4000));
		expect(noteText(result.messages[2]!)).toContain(`Full text: ${file}`);
		const again = applyOverflowGuard(messages, { limit: 1_200, fixedTokens: 0, estimate, saveDirectory: dir, protectBefore: 2 });
		expect(again.messages[2]).toBe(result.messages[2]!); // same note object across calls
		// A note is never withheld again.
		const stacked = applyOverflowGuard(result.messages, { limit: 10, fixedTokens: 0, estimate, saveDirectory: dir });
		expect(stacked.withheld.map((w) => w.toolCallId)).toEqual(["old"]);
	});

	test("a note-shaped result from elsewhere (e.g. restored from the mirror) is not withheld", () => {
		const restored: LiveContextMessage = { ...tool("r", 0), content: [{ type: "text", text: `${WITHHELD_NOTE_PREFIX} read#r (~9 tok) withheld over budget.` }] };
		const result = applyOverflowGuard([user, restored], { limit: 1, fixedTokens: 0, estimate });
		expect(result.withheld).toHaveLength(0);
		expect(result.messages[1]).toBe(restored);
	});

	test("file names: sanitized, include the message id, bounded at 120 characters", () => {
		const dir = mkdtempSync(join(tmpdir(), "clm-overflow-id-"));
		const result = applyOverflowGuard([user, tool("../call/1", 4000)], { limit: 10, fixedTokens: 0, estimate, saveDirectory: dir });
		expect(result.withheld[0]!.file).toBe(join(dir, "msg_a-___call_1.txt"));
		// The same call id in two OpenCode messages yields two files.
		const first = { ...tool("call_1", 4000), ocMessageID: "msg_1" };
		const second = { ...tool("call_1", 4000), ocMessageID: "msg_2", content: [{ type: "text", text: "y".repeat(4000) }] };
		const both = applyOverflowGuard([user, first, second], { limit: 10, fixedTokens: 0, estimate, saveDirectory: dir });
		const files = both.withheld.map((w) => w.file!);
		expect(files).toEqual([join(dir, "msg_1-call_1.txt"), join(dir, "msg_2-call_1.txt")]);
		expect(readFileSync(files[0]!, "utf8")).toBe("x".repeat(4000));
		expect(readFileSync(files[1]!, "utf8")).toBe("y".repeat(4000));
		// A very long id is cut and suffixed with a hash of the text.
		const long = applyOverflowGuard([user, tool("c".repeat(500), 4000)], { limit: 10, fixedTokens: 0, estimate, saveDirectory: dir });
		const name = long.withheld[0]!.file!.slice(dir.length + 1);
		expect(name.length).toBeLessThanOrEqual(120);
		expect(name).toMatch(/^msg_a-c+-[0-9a-f]{12}\.txt$/);
		expect(withheldFileName(tool("c".repeat(500), 1), 0, "a")).not.toBe(withheldFileName(tool("c".repeat(500), 1), 0, "b"));
	});

	test("the directory is 0700, the file 0600, and a symlink at the target is not followed", () => {
		const root = mkdtempSync(join(tmpdir(), "clm-overflow-mode-"));
		const dir = join(root, "withheld");
		mkdirSync(dir, { mode: 0o755 });
		chmodSync(dir, 0o755);
		const result = applyOverflowGuard([user, tool("a", 4000)], { limit: 10, fixedTokens: 0, estimate, saveDirectory: dir });
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(result.withheld[0]!.file!).mode & 0o777).toBe(0o600);
		const target = join(root, "victim");
		writeFileSync(target, "keep");
		symlinkSync(target, join(dir, "msg_a-b.txt"));
		const linked = applyOverflowGuard([user, tool("b", 4000)], { limit: 10, fixedTokens: 0, estimate, saveDirectory: dir });
		expect(linked.withheld[0]!.file).toBeUndefined();
		expect(readFileSync(target, "utf8")).toBe("keep");
	});

	test("an unwritable save directory falls back to a history-only note", () => {
		const blocker = join(mkdtempSync(join(tmpdir(), "clm-overflow-bad-")), "file");
		writeFileSync(blocker, "");
		const result = applyOverflowGuard([user, tool("a", 4000)], { limit: 10, fixedTokens: 0, estimate, saveDirectory: join(blocker, "sub") });
		expect(result.withheld[0]!.file).toBeUndefined();
		expect(noteText(result.messages[1]!)).toContain("Full text remains in the session history.");
	});

	test("the saved file holds the uncapped output when the observation cap cut it", () => {
		const dir = mkdtempSync(join(tmpdir(), "clm-overflow-cap-"));
		const full = tool("a", 5000);
		const capped = capObservations([user, full], resolveObservationCap({ maxCharacters: 1000 }));
		expect(capped[1]).not.toBe(full);
		const result = applyOverflowGuard(capped, { limit: 10, fixedTokens: 0, estimate, saveDirectory: dir });
		expect(readFileSync(result.withheld[0]!.file!, "utf8")).toBe("x".repeat(5000));
		// The note drops the cap flag and keeps the withheld flag.
		expect(capped[1]!.capped).toBe(true);
		expect(result.messages[1]!.capped).toBeUndefined();
		expect("capped" in result.messages[1]!).toBe(false);
		expect(result.messages[1]!.withheld).toBe(true);
	});

	test("re-reading a withheld file does not loop: the fresh result survives, an older one goes", () => {
		const dir = mkdtempSync(join(tmpdir(), "clm-overflow-loop-"));
		const first = [user, tool("a", 4000), tool("b", 4000)];
		const r1 = applyOverflowGuard(first, { limit: 1_200, fixedTokens: 0, estimate, saveDirectory: dir });
		expect(r1.withheld.map((w) => w.toolCallId)).toEqual(["a"]);
		// The model re-reads a's file; that result is now the newest.
		const reread = tool("a-again", 4000);
		const r2 = applyOverflowGuard([...r1.messages, reread], { limit: 1_200, fixedTokens: 0, estimate, saveDirectory: dir });
		expect(r2.withheld.map((w) => w.toolCallId)).toEqual(["b"]);
		expect(r2.messages[3]).toBe(reread);
	});

	test("withheldNoteText names tool, call id, size and file", () => {
		expect(withheldNoteText({ toolCallId: "call_1", toolName: "bash", tokens: 12_345, file: "/x/withheld/call_1.txt" }))
			.toBe("[clm overflow guard] bash#call_1 (~12,345 tok) withheld over budget. Full text: /x/withheld/call_1.txt");
	});

	test("notice names the results, the limit and whether it now fits", () => {
		const result = applyOverflowGuard([user, tool("a", 4000)], { limit: 500, fixedTokens: 100, estimate });
		const text = overflowNoticeText(result, 500);
		expect(text).toMatch(/^\[CLM BUDGET\] Overflow guard: .*limit of 500 tokens, so 1 tool result was withheld/);
		expect(text).toMatch(/read#a \(~1,00\d tok\)/);
		expect(text).toContain("Nothing was re-run");
		expect(text).not.toContain("with file paths");
		expect(text).not.toContain("still over");
		const stillOver = applyOverflowGuard(
			[user, tool("b", 4000), tool("c", 4000), { role: "user", content: "y".repeat(10_000), timestamp: 2 }],
			{ limit: 500, fixedTokens: 0, estimate, saveDirectory: mkdtempSync(join(tmpdir(), "clm-overflow-notice-")) },
		);
		const over = overflowNoticeText(stillOver, 500);
		expect(over).toContain("2 tool results were withheld");
		expect(over).toContain("with file paths");
		expect(over).toContain("still over the limit; edit your context now");
	});
});
