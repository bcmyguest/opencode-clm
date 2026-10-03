// Adapted from pi-clm src/steering.ts (MIT, Copyright 2026 Emanuel Casco).
/**
 * Steering document: the one place where context-management *strategy* may enter the
 * prompt. The harness itself only states the editing protocol; a steering file tells the
 * model when to compact, what to keep, how to structure notes, and so on. It is
 * swappable so experiments can compare "no strategy" against a paper-style brief or an
 * evolved skill, and it is hashed so runs can be attributed to an exact document.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export interface SteeringDocument {
	path: string;
	name: string;
	text: string;
	/** First 12 hex chars of the SHA-256 of the file bytes (matches `sha256sum`). */
	hash: string;
}

export function steeringPathFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
	const raw = env.CLM_STEERING?.trim();
	if (!raw || raw === "none" || raw === "off") return undefined;
	return raw;
}

export function loadSteeringDocument(path: string): SteeringDocument {
	const absolute = resolve(path);
	let raw: Buffer;
	try {
		raw = readFileSync(absolute);
	} catch (error) {
		throw new Error(`steering: cannot read ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const text = raw.toString("utf8").trim();
	if (!text) throw new Error(`steering: document is empty: ${absolute}`);
	return {
		path: absolute,
		name: basename(absolute),
		text,
		// Hash of the file bytes, so it matches `sha256sum <file>`.
		hash: createHash("sha256").update(raw).digest("hex").slice(0, 12),
	};
}

/** System-prompt section appended after the editing protocol. */
export function steeringPromptSection(doc: SteeringDocument): string {
	return `## Context-management guidance (${doc.name})\n\n${doc.text}`;
}

export function steeringStatusLine(doc: SteeringDocument | undefined): string {
	return doc ? `steering: ${doc.name} (sha256sum ${doc.hash}…) · ${doc.path}` : "steering: none (protocol only)";
}
