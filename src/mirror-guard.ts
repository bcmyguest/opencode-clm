// Adapted from pi-clm src/mirror-guard.ts (MIT, Copyright 2026 Emanuel Casco).

import { dirname, resolve } from "node:path";

/**
 * What a tool call does to the mirror file.
 *
 * - "write": the call mutates the mirror (edit/write/apply_patch tools, or a bash command
 *   with an explicit write indicator).
 * - "read": the read tool targets the mirror, or a bash command references it without a
 *   recognized write indicator (header discovery, grep, head). Allowed and never counted,
 *   so inspection cannot consume the write allowance.
 * - "none": the call does not reference the mirror.
 *
 * Bash classification is a heuristic on command text; validation before the next request
 * remains the correctness boundary regardless of how a mutation was performed.
 */
export type MirrorToolIntent = "write" | "read" | "none";

const WRITE_INDICATOR = new RegExp(
	[
		String.raw`>>?`,
		String.raw`\btee\b`,
		String.raw`\bsed\s+(?:-\S+\s+)*-i\b`,
		String.raw`\bperl\s+(?:-\S+\s+)*-i\b`,
		String.raw`\btruncate\b`,
		String.raw`\brm\b`,
		String.raw`\bmv\b`,
		String.raw`\bcp\b`,
		String.raw`\bdd\b`,
		String.raw`\binstall\b`,
		String.raw`\bln\b`,
		String.raw`\brsync\b`,
		String.raw`\bex\b`,
		String.raw`write_text\s*\(`,
		String.raw`\.write\s*\(`,
		String.raw`\bwritelines\s*\(`,
		String.raw`writeFile(?:Sync)?\s*\(`,
		String.raw`\bopen\s*\([^()]*["'][wax+]`,
		String.raw`\.open\(\s*["'][wax]`,
		String.raw`\bmode\s*=\s*["'][wax]`,
	].join("|"),
);

/** Redirections that never write the mirror: fd duplication (`2>&1`, `>&2`) and `/dev/null`. */
const HARMLESS_REDIRECT = /\d*>&\d+|[12&]?>>?\s*\/dev\/null/g;

/** File headers of OpenCode's `apply_patch` format (`*** Update File: <path>` and kin). */
const PATCH_PATH = /^\s*\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does the command name the mirror file, its directory, or the mirror's basename? */
function referencesMirror(command: string, mirrorPath: string): boolean {
	if (command.includes(mirrorPath) || command.includes("LIVE_CONTEXT.md")) return true;
	const directory = new RegExp(`${escapeRegExp(dirname(mirrorPath))}(?=$|[/\\s"'\`;|&)])`);
	return directory.test(command);
}

function pathArg(input: Record<string, unknown>): string {
	const given = typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : "";
	return given.replace(/^@/, "");
}

function patchPaths(patchText: string): string[] {
	return [...patchText.matchAll(PATCH_PATH)].map((match) => match[1]!);
}

export function classifyMirrorToolCall(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	mirrorPath: string,
): MirrorToolIntent {
	const isMirror = (path: string) => path !== "" && resolve(cwd, path) === mirrorPath;
	switch (toolName) {
		case "edit":
		case "write":
			return isMirror(pathArg(input)) ? "write" : "none";
		case "apply_patch":
			return typeof input.patchText === "string" && patchPaths(input.patchText).some(isMirror) ? "write" : "none";
		case "read":
			return isMirror(pathArg(input)) ? "read" : "none";
		case "bash": {
			if (typeof input.command !== "string") return "none";
			const command = input.command;
			if (!referencesMirror(command, mirrorPath)) return "none";
			return WRITE_INDICATOR.test(command.replace(HARMLESS_REDIRECT, " ")) ? "write" : "read";
		}
		default:
			return "none";
	}
}
