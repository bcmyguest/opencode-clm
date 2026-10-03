// Adapted from pi-clm src/__tests__/compact.test.ts (MIT, Copyright 2026 Emanuel Casco).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCompactPrompt, compactPromptFromEnv, DEFAULT_COMPACT_PROMPT, loadCompactPrompt } from "../src/compact.ts";

describe("/clm-compact", () => {
	test("the prompt fills placeholders, leaves unknown ones, and drops the empty instructions line", () => {
		const values = { mirror: "/tmp/LIVE_CONTEXT.md", current: 110_000, budget: 1_000_000 };
		const prompt = buildCompactPrompt(DEFAULT_COMPACT_PROMPT, values);
		expect(prompt).toMatch(/^Compact your live context now\./);
		expect(prompt).toMatch(/about 110,000 tokens \(budget 1,000,000\)\. Your context is mirrored at `\/tmp\/LIVE_CONTEXT\.md`/);
		expect(prompt).not.toMatch(/\{\{|Also:|\n{3}/);
		expect(buildCompactPrompt(DEFAULT_COMPACT_PROMPT, { ...values, instructions: " keep ids " })).toMatch(/\n\nAlso: keep ids\n\n/);
		expect(buildCompactPrompt("{{current}}{{budget}} {{other}}", { ...values, budget: undefined })).toBe("110,000 {{other}}");
		// Only its own placeholders are filled.
		expect(buildCompactPrompt("{{constructor}} {{__proto__}} {{toString}}", values)).toBe("{{constructor}} {{__proto__}} {{toString}}");
		// Typed instructions are never dropped.
		expect(buildCompactPrompt("Shrink {{mirror}}.", { ...values, instructions: "keep ids" })).toBe("Shrink /tmp/LIVE_CONTEXT.md.\n\nAlso: keep ids");
		// Only the empty slot's blank lines collapse.
		expect(buildCompactPrompt("A\n\n\n\nB\n\n{{instructions}}\n\nC", values)).toBe("A\n\n\n\nB\n\nC");
		expect(buildCompactPrompt("A {{instructions}}B", values)).toBe("A B");
	});

	test("env keywords mean the built-in prompt", () => {
		expect(compactPromptFromEnv({})).toBeUndefined();
		expect(compactPromptFromEnv({ CLM_COMPACT_PROMPT: " Default " })).toBeUndefined();
		expect(compactPromptFromEnv({ CLM_COMPACT_PROMPT: "off" })).toBeUndefined();
		expect(compactPromptFromEnv({ CLM_COMPACT_PROMPT: "prompts/team.md" })).toBe("prompts/team.md");
	});

	test("a custom template is read on use; missing or empty files are errors", () => {
		const directory = mkdtempSync(join(tmpdir(), "clm-compact-test-"));
		try {
			const path = join(directory, "prompt.md");
			expect(loadCompactPrompt(undefined)).toBe(DEFAULT_COMPACT_PROMPT);
			writeFileSync(path, "  Compact {{mirror}}.  \n");
			expect(loadCompactPrompt(path)).toBe("Compact {{mirror}}.");
			writeFileSync(path, "\n");
			expect(() => loadCompactPrompt(path)).toThrow(/^compactPrompt: template is empty/);
			expect(() => loadCompactPrompt(join(directory, "missing.md"))).toThrow(/^compactPrompt: cannot read .*missing\.md: ENOENT/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
