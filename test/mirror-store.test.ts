// Adapted from pi-clm src/__tests__/mirror-store.test.ts (MIT, Copyright 2026 Emanuel Casco).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { defaultMirrorParent, MirrorStore } from "../src/mirror-store.ts";

async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
	const saved = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		return await fn();
	} finally {
		if (saved === undefined) delete process.env[name];
		else process.env[name] = saved;
	}
}

async function withUmask<T>(mask: number, fn: () => Promise<T>): Promise<T> {
	const saved = process.umask(mask);
	try {
		return await fn();
	} finally {
		process.umask(saved);
	}
}

async function withParent<T>(fn: (parent: string) => Promise<T>): Promise<T> {
	const parent = await mkdtemp(join(tmpdir(), "clm-store-test-"));
	try {
		return await fn(parent);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
}

describe("MirrorStore", () => {
	test("writes atomically with private directory and file modes", async () => {
		await withParent(async (parent) => {
			const store = await MirrorStore.create("session/with unsafe chars", parent);
			expect(store.directory).toBe(join(parent, "clm-session-with-unsafe-chars"));
			await store.write("revision one");
			expect(await store.read()).toBe("revision one");
			expect(store.readSync()).toBe("revision one");
			expect(await readFile(store.filePath, "utf8")).toBe("revision one");
			expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
			expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);

			await store.write("revision two");
			expect(await store.read()).toBe("revision two");
			expect((await readdir(store.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
			await store.cleanup();
			await expect(access(store.directory)).rejects.toThrow();
		});
	});

	test("the same session id resumes the same directory and its saved mirror", async () => {
		await withParent(async (parent) => {
			const first = await MirrorStore.create("same-session", parent);
			await first.write("saved");
			const resumed = await MirrorStore.create("same-session", parent);
			expect(resumed.directory).toBe(first.directory);
			expect(await resumed.read()).toBe("saved");
			const other = await MirrorStore.create("other-session", parent);
			expect(other.directory).not.toBe(first.directory);
			expect(await other.read()).toBeUndefined();
		});
	});

	test("creates a missing parent privately and ignores it in git", async () => {
		await withParent(async (root) => {
			const parent = join(root, "nested", "clm");
			const store = await MirrorStore.create("session", parent);
			expect((await stat(parent)).mode & 0o777).toBe(0o700);
			expect(await readFile(join(parent, ".gitignore"), "utf8")).toBe("*\n");
			await writeFile(join(parent, ".gitignore"), "custom\n");
			await MirrorStore.create("session", parent);
			expect(await readFile(join(parent, ".gitignore"), "utf8")).toBe("custom\n");
			await store.cleanup();
		});
	});

	test("the default parent is per-user state, not the shared temp directory", async () => {
		await withEnv("XDG_STATE_HOME", undefined, async () => {
			expect(defaultMirrorParent()).toBe(join(homedir(), ".local", "state", "opencode-clm", "mirrors"));
			expect(defaultMirrorParent().startsWith(tmpdir())).toBe(false);
		});
		await withEnv("XDG_STATE_HOME", "/xdg/state", async () => {
			expect(defaultMirrorParent()).toBe("/xdg/state/opencode-clm/mirrors");
		});
	});

	test("an existing default parent is made private under umask 022", async () => {
		await withParent(async (root) => {
			await withEnv("XDG_STATE_HOME", root, () =>
				withUmask(0o022, async () => {
					const parent = join(root, "opencode-clm", "mirrors");
					await mkdir(parent, { recursive: true });
					await chmod(parent, 0o755);
					const store = await MirrorStore.create("session");
					expect(store.directory).toBe(join(parent, "clm-session"));
					expect((await stat(parent)).mode & 0o777).toBe(0o700);
					expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
				}),
			);
		});
	});

	test("a parent the store creates is private under umask 022; an existing explicit parent keeps its mode", async () => {
		await withParent(async (root) => {
			await withUmask(0o022, async () => {
				const created = join(root, "created");
				await MirrorStore.create("session", created);
				expect((await stat(created)).mode & 0o777).toBe(0o700);

				const existing = join(root, "existing");
				await mkdir(existing);
				await chmod(existing, 0o755);
				await MirrorStore.create("session", existing);
				expect((await stat(existing)).mode & 0o777).toBe(0o755);
			});
		});
	});

	test("a symlinked session directory is refused", async () => {
		await withParent(async (parent) => {
			const target = join(parent, "elsewhere");
			await mkdir(target);
			await symlink(target, join(parent, "clm-session"));
			await expect(MirrorStore.create("session", parent)).rejects.toThrow(/not a real directory/);
		});
	});

	test("the sweep keeps an old directory whose mirror file is fresh", async () => {
		await withParent(async (parent) => {
			const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
			const live = join(parent, "clm-written-in-place");
			await mkdir(live);
			await writeFile(join(live, "LIVE_CONTEXT.md"), "fresh");
			await utimes(live, past, past);

			const store = await MirrorStore.create("session", parent);
			expect(existsSync(live)).toBe(true);
			await store.cleanup();
		});
	});

	test("creation sweeps stale mirror directories and keeps recent ones", async () => {
		await withParent(async (parent) => {
			const stale = join(parent, "clm-crashed-abc123");
			await mkdir(stale);
			await writeFile(join(stale, "LIVE_CONTEXT.md"), "orphaned");
			const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
			await utimes(join(stale, "LIVE_CONTEXT.md"), past, past);
			await utimes(stale, past, past);

			const recent = join(parent, "clm-running-def456");
			await mkdir(recent);
			const unrelated = join(parent, "unrelated-directory");
			await mkdir(unrelated);
			await utimes(unrelated, past, past);

			const store = await MirrorStore.create("session", parent);
			await expect(access(stale)).rejects.toThrow();
			expect(existsSync(recent)).toBe(true);
			expect(existsSync(unrelated)).toBe(true);
			await store.cleanup();
		});
	});

	test("cleanup is idempotent and disposed stores reject writes", async () => {
		await withParent(async (parent) => {
			const store = await MirrorStore.create("session", parent);
			await store.cleanup();
			await store.cleanup();
			expect(await store.read()).toBeUndefined();
			expect(store.readSync()).toBeUndefined();
			await expect(store.write("late write")).rejects.toThrow(/disposed/);
		});
	});
});
