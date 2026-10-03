/**
 * Per-session settings changes on disk: `<session dir>/overrides.json` =
 * `{ version: 1, overrides }`, holding only what differs from the base (the plugin options,
 * environment and defaults; for `editing`, state.json's `enabled`). A separate file because
 * state.json belongs to the server's save queue: the TUI writes this file and never state.json.
 *
 * Writers (the TUI panel, typed `/clm config` in the TUI, and the server's `/clm config`)
 * all go through `changeSetting`: parse → merge → drop base-equal keys → stage (resolve the
 * policies, load a steering document or compact prompt strictly) → write atomically. A
 * change that fails any step is reported and not written. The server reads the file before
 * each request (`ClmSession.refreshSettings`). Staging follows pi-clm src/index.ts
 * `changeSetting` / `stageSettings` (MIT, Copyright 2026 Emanuel Casco); written for this package.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic.ts";
import { loadCompactPrompt } from "./compact.ts";
import {
	applyOverrides,
	describeSetting,
	mergeOverrides,
	sanitizeOverrides,
	settingDescriptor,
	unknownSettingText,
	type ClmOverrides,
	type FormatContext,
	type SettingsValues,
} from "./settings-table.ts";
import type { ClmSettings } from "./settings.ts";
import { loadSteeringDocument, type SteeringDocument } from "./steering.ts";

export const OVERRIDES_FILE = "overrides.json";
export const OVERRIDES_VERSION = 1;

export interface OverridesRead {
	overrides: ClmOverrides;
	/** Keys dropped as invalid, or a description of why the whole file was unusable. */
	warning?: string;
}

export function overridesPath(sessionDirectory: string): string {
	return join(sessionDirectory, OVERRIDES_FILE);
}

/** Reads and sanitizes overrides.json. Missing → no overrides. Never throws. */
export async function readOverrides(sessionDirectory: string): Promise<OverridesRead> {
	const path = overridesPath(sessionDirectory);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { overrides: {} };
		return { overrides: {}, warning: `could not read ${path}: ${describe(error)}` };
	}
	return parseOverridesText(text, path);
}

export function parseOverridesText(text: string, path = OVERRIDES_FILE): OverridesRead {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { overrides: {}, warning: `${path} is not valid JSON (${describe(error)}); using the defaults` };
	}
	if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== OVERRIDES_VERSION) {
		return { overrides: {}, warning: `${path} has an unknown format; using the defaults` };
	}
	const { overrides, ignored } = sanitizeOverrides((parsed as { overrides?: unknown }).overrides);
	return ignored.length > 0 ? { overrides, warning: `ignored invalid saved settings: ${ignored.join(", ")}` } : { overrides };
}

export async function writeOverrides(sessionDirectory: string, overrides: ClmOverrides): Promise<void> {
	await writeJsonAtomic(overridesPath(sessionDirectory), { version: OVERRIDES_VERSION, overrides });
}

export interface StagedSettings {
	settings: ClmSettings;
	steering?: SteeringDocument;
	/** Set when the steering document could not be loaded (non-strict staging only). */
	steeringError?: string;
}

/**
 * Resolves base + overrides without activating anything. Strict (an interactive change):
 * a steering document or compact prompt that does not load rejects the change. Not strict
 * (reading the file before a request): a steering failure is recorded and the session runs
 * protocol-only. `loaded` reuses an already loaded document for the same path.
 */
export function stageSettings(
	base: ClmSettings,
	overrides: ClmOverrides,
	options: { strict: boolean; loaded?: SteeringDocument },
): StagedSettings {
	const settings = applyOverrides(base, overrides);
	const staged: StagedSettings = { settings };
	const path = settings.steeringPath;
	if (path) {
		if (options.loaded && !options.strict && options.loaded.path === path) {
			staged.steering = options.loaded;
		} else {
			try {
				staged.steering = loadSteeringDocument(path);
			} catch (error) {
				if (options.strict) throw new Error(`steering document not loaded: ${describe(error)}`);
				staged.steeringError = describe(error);
			}
		}
	}
	if (options.strict && settings.compactPromptPath && settings.compactPromptPath !== base.compactPromptPath) {
		loadCompactPrompt(settings.compactPromptPath);
	}
	return staged;
}

export interface ChangeRequest {
	/** The session directory (`<mirrorDir>/clm-<id>`). */
	sessionDirectory: string;
	/** Settings at load (options, environment, defaults). */
	base: ClmSettings;
	/** `editing` base: state.json's `enabled`. */
	baseEditing: boolean;
	/** Relative paths resolve against the project directory. */
	projectDirectory: string;
	format?: FormatContext;
}

export interface ChangeResult {
	overrides: ClmOverrides;
	values: SettingsValues;
	/** `Budget: 20k`. */
	text: string;
}

function valuesOf(base: ClmSettings, baseEditing: boolean, overrides: ClmOverrides, settings?: ClmSettings): SettingsValues {
	return { editing: overrides.editing ?? baseEditing, settings: settings ?? applyOverrides(base, overrides) };
}

/**
 * `/clm config <setting> <value>` and the panel's apply: validate, then write. Throws a
 * user-facing message; nothing is written then.
 */
export async function changeSetting(request: ChangeRequest, name: string, text: string): Promise<ChangeResult> {
	const descriptor = settingDescriptor(name);
	if (!descriptor) throw new Error(unknownSettingText(name));
	const parsed = descriptor.parse(text, { directory: request.projectDirectory });
	const current = await readOverrides(request.sessionDirectory);
	const baseValues = valuesOf(request.base, request.baseEditing, {}, request.base);
	const overrides = mergeOverrides(baseValues, current.overrides, parsed);
	const staged = stageSettings(request.base, overrides, { strict: true });
	try {
		await writeOverrides(request.sessionDirectory, overrides);
	} catch (error) {
		throw new Error(`Settings unchanged: saving ${overridesPath(request.sessionDirectory)} failed (${describe(error)}).`);
	}
	const values = valuesOf(request.base, request.baseEditing, overrides, staged.settings);
	return { overrides, values, text: `${descriptor.label}: ${descriptor.format(values, request.format)}` };
}

/** `/clm config reset`: drop this session's changes. */
export async function resetSettings(sessionDirectory: string): Promise<void> {
	try {
		await writeOverrides(sessionDirectory, {});
	} catch (error) {
		throw new Error(`Settings unchanged: saving ${overridesPath(sessionDirectory)} failed (${describe(error)}).`);
	}
}

/**
 * Current values of one session, read from its overrides.json (non-strict, never throws for
 * bad files). `mtimeMs`: when overrides.json was last written, if it exists.
 */
export async function sessionValues(sessionDirectory: string, base: ClmSettings, baseEditing: boolean): Promise<SessionValues> {
	const read = await readOverrides(sessionDirectory);
	const mtimeMs = await stat(overridesPath(sessionDirectory)).then((info) => info.mtimeMs, () => undefined);
	return overridesValues(read, base, baseEditing, mtimeMs);
}

export interface SessionValues {
	values: SettingsValues;
	warning?: string;
	overrides: ClmOverrides;
	mtimeMs?: number;
}

/** `sessionValues` for overrides already read (e.g. through the server's file API). */
export function overridesValues(read: OverridesRead, base: ClmSettings, baseEditing: boolean, mtimeMs?: number): SessionValues {
	const at = mtimeMs !== undefined ? { mtimeMs } : {};
	try {
		return { values: valuesOf(base, baseEditing, read.overrides), overrides: read.overrides, ...(read.warning ? { warning: read.warning } : {}), ...at };
	} catch (error) {
		return { values: valuesOf(base, baseEditing, {}, base), overrides: {}, warning: `ignored saved settings: ${describe(error)}`, ...at };
	}
}

/** `/clm config <setting>`: `Label: value — description`. */
export function showSetting(name: string, values: SettingsValues, format?: FormatContext): string {
	const descriptor = settingDescriptor(name);
	if (!descriptor) throw new Error(unknownSettingText(name));
	return describeSetting(descriptor, values, format);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
