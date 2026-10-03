import type { ContextDocumentSnapshot } from "../src/types.ts";

function escape(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The edit the system prompt teaches: replace one block body, keeping its header. */
export function replaceBody(text: string, id: string, body: string): string {
	const re = new RegExp(`(^\\[\\[CTX_TURN [^\\n]* id=${escape(id)} [^\\n]*\\]\\]\\n)[\\s\\S]*?(?=\\n\\n\\[\\[CTX_TURN |$(?![\\s\\S]))`, "m");
	if (!re.test(text)) throw new Error(`block not found: ${id}`);
	return text.replace(re, (_match, header: string) => header + body);
}

export function deleteBlock(text: string, id: string): string {
	const re = new RegExp(`\\n*^\\[\\[CTX_TURN [^\\n]* id=${escape(id)} [^\\n]*\\]\\]\\n[\\s\\S]*?(?=\\n\\n\\[\\[CTX_TURN |$(?![\\s\\S]))`, "m");
	if (!re.test(text)) throw new Error(`block not found: ${id}`);
	return text.replace(re, "");
}

/** Block id of the n-th block (0-based) whose role matches. */
export function blockId(snapshot: ContextDocumentSnapshot, role: string, nth = 0): string {
	const block = snapshot.blocks.filter((candidate) => candidate.role === role)[nth];
	if (!block) throw new Error(`no ${role} block #${nth}`);
	return block.id;
}

export function header(snapshot: ContextDocumentSnapshot, id: string): string {
	return snapshot.blocks.find((block) => block.id === id)!.header;
}
