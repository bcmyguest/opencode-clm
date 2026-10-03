// Adapted from pi-clm src/__tests__/observation-steering.test.ts, steering part (MIT, Copyright 2026 Emanuel Casco).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOUSE_STEERING } from "../src/settings.ts";
import { loadSteeringDocument, steeringPathFromEnv, steeringPromptSection, steeringStatusLine } from "../src/steering.ts";

describe("steering document", () => {
	test("env, load, hash, prompt section and status", () => {
		expect(steeringPathFromEnv({})).toBeUndefined();
		expect(steeringPathFromEnv({ CLM_STEERING: "none" })).toBeUndefined();
		expect(steeringPathFromEnv({ CLM_STEERING: "off" })).toBeUndefined();
		const dir = mkdtempSync(join(tmpdir(), "clm-steering-"));
		try {
			const path = join(dir, "brief.md");
			writeFileSync(path, "Compact at sub-question boundaries.\n");
			expect(steeringPathFromEnv({ CLM_STEERING: path })).toBe(path);
			const doc = loadSteeringDocument(path);
			expect(doc.name).toBe("brief.md");
			expect(doc.text).toBe("Compact at sub-question boundaries.");
			// sha256("Compact at sub-question boundaries.\n"), first 12 hex chars: the file bytes, as sha256sum.
			expect(doc.hash).toBe(new Bun.CryptoHasher("sha256").update("Compact at sub-question boundaries.\n").digest("hex").slice(0, 12));
			expect(steeringPromptSection(doc)).toMatch(/^## Context-management guidance \(brief\.md\)\n\nCompact at/);
			expect(steeringStatusLine(doc)).toMatch(/steering: brief\.md \(sha256sum [a-f0-9]{12}…\)/);
			expect(steeringStatusLine(undefined)).toBe("steering: none (protocol only)");
			writeFileSync(path, "   \n");
			expect(() => loadSteeringDocument(path)).toThrow(/empty/);
			expect(() => loadSteeringDocument(join(dir, "missing.md"))).toThrow(/^steering: cannot read .*missing\.md: ENOENT/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the shipped house-brief steering document loads without a provenance comment", () => {
		const doc = loadSteeringDocument(HOUSE_STEERING);
		expect(doc.text).toMatch(/When to act/);
		expect(doc.text).toMatch(/Never fabricate/);
		// Byte-identical to pi-clm's file, so the steering hash matches across both harnesses;
		// the MIT credit lives in the README, not in the prompt.
		expect(doc.text.startsWith("You manage your own context.")).toBe(true);
	});
});
