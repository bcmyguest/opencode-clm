// Atomic replacement of small session files (overrides.json, snapshot.json, rN.json): write
// a temp file with mode 0600 next to the target, then rename it over the target, so a
// reader never sees a torn file. Written for this package.
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeFileAtomic(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(text, "utf8");
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

export function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	return writeFileAtomic(path, `${JSON.stringify(value, null, 1)}\n`);
}
