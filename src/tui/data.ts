// Host data the TUI panel needs, extracted from plain values so it is testable without
// opentui: the server plugin's options, the newest provider count, the model limits and
// the read-only settings rows. Written for this package.

import { resolveBudget } from "../budget.ts";
import type { LatestUsage, PanelModel, PanelSettings, SettingRow } from "../panel/model.ts";
import { formatTokenCount, type TimelinePoint } from "../panel/timeline.ts";
import type { ClmSettings } from "../settings.ts";
import { applyOverrides, changedSettings, sanitizeOverrides, SETTINGS_TABLE, type FormatContext, type SettingsValues } from "../settings-table.ts";

/**
 * The package by name, with any version, tag or source after `@` (`opencode-clm`,
 * `opencode-clm@0.2.0`, `opencode-clm@latest`, `opencode-clm@file:/x/opencode-clm-0.2.0.tgz`
 * as `opencode plugin <tarball>` writes it), optionally behind `npm:`.
 */
const NPM_SPEC = /^(?:npm:)?opencode-clm(?:@.*)?$/;
/** A path or URL whose last segment names the package (a checkout, an unpacked or packed copy). */
const PATH_NAME = /(?:^|\/)opencode-clm(?:@[^/]*|-\d[^/]*\.tgz)?\/?$/;

/** True when a server plugin spec names this package. */
export function isPackageSpec(spec: string, packageIndexUrl: string): boolean {
	if (NPM_SPEC.test(spec)) return true;
	// Another package's `name@version-or-source`: the source may be a path, but the name decides.
	if (/^(?:npm:)?(?:@[^/@]+\/)?[^@/.~][^@/]*@/.test(spec)) return false;
	const target = normalizeUrl(packageIndexUrl);
	const packageDirectory = target.replace(/\/index\.ts$/, "");
	const path = spec.startsWith("file:") ? normalizeUrl(spec) : spec.includes("/") ? spec.replace(/\/+$/, "") : undefined;
	if (path === undefined) return false;
	if (path === target || path === packageDirectory) return true;
	return PATH_NAME.test(path) || /(?:^|\/)opencode-clm\/index\.ts$/.test(path);
}

/**
 * Options of the server plugin entry in `api.state.config.plugin` (see `isPackageSpec`).
 * Undefined when no entry matches (the caller falls back to the TUI plugin's options).
 */
export function serverPluginOptions(entries: unknown, packageIndexUrl: string): Record<string, unknown> | undefined {
	if (!Array.isArray(entries)) return undefined;
	for (const entry of entries) {
		const [spec, options] = Array.isArray(entry) ? entry : [entry, undefined];
		if (typeof spec !== "string") continue;
		if (!isPackageSpec(spec, packageIndexUrl)) continue;
		return options && typeof options === "object" && !Array.isArray(options) ? (options as Record<string, unknown>) : {};
	}
	return undefined;
}

function normalizeUrl(value: string): string {
	try {
		return decodeURIComponent(new URL(value).pathname).replace(/\/+$/, "");
	} catch {
		return value;
	}
}

interface MessageLike {
	role?: string;
	time?: { created?: number; completed?: number };
	error?: unknown;
	summary?: boolean;
	tokens?: { input?: number; cache?: { read?: number; write?: number } };
	providerID?: string;
	modelID?: string;
}

/**
 * The newest assistant reply with usage, measured as clm.ts measures `observedPrevious`
 * (input + cache read + cache write). Errored and summary messages are skipped.
 */
export function latestUsage(messages: ReadonlyArray<unknown>): LatestUsage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as MessageLike;
		if (message?.role !== "assistant" || message.error || message.summary || !message.tokens) continue;
		const tokens = Number(message.tokens.input ?? 0) + Number(message.tokens.cache?.read ?? 0) + Number(message.tokens.cache?.write ?? 0);
		if (!Number.isFinite(tokens) || tokens <= 0) continue;
		return { tokens, ...(message.time?.completed !== undefined ? { completedAt: message.time.completed } : {}) };
	}
	return undefined;
}

/** Context and output limits of the model of the newest assistant message. */
export function modelLimits(messages: ReadonlyArray<unknown>, providers: ReadonlyArray<unknown>): { context?: number; output?: number } {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as MessageLike;
		if (message?.role !== "assistant" || !message.providerID || !message.modelID) continue;
		const provider = providers.find((item) => (item as { id?: string })?.id === message.providerID) as
			| { models?: Record<string, { limit?: { context?: number; output?: number } }> }
			| undefined;
		const limit = provider?.models?.[message.modelID]?.limit;
		return { context: limit?.context, output: limit?.output };
	}
	return {};
}

/** Budget for sessions without snapshot.json, resolved as the server resolves it. */
export function fallbackBudget(settings: ClmSettings, limits: { context?: number; output?: number }) {
	const resolved = resolveBudget(settings.budget, limits.context, limits.output);
	if (!resolved) return undefined;
	const cap = limits.context !== undefined
		? limits.context - (limits.output !== undefined && limits.output > 0 && limits.output < limits.context ? limits.output : 0)
		: undefined;
	return { budget: resolved.budget, reserve: resolved.reserve, source: resolved.source, ...(cap !== undefined ? { cap } : {}) };
}

/**
 * Settings page rows from the settings table: the values in force (base + this session's
 * overrides.json), marked when changed, with choices or a placeholder so Enter cycles or
 * prompts. `base` is what the session would use without overrides.
 */
export function settingsView(
	values: { base: SettingsValues; effective: SettingsValues },
	model: Pick<PanelModel, "budgetInfo" | "timeline" | "mirrorPath"> & Partial<Pick<PanelModel, "calibration" | "steering" | "annotations">>,
	options: { format?: FormatContext; warning?: string } = {},
): PanelSettings {
	const changed = new Set<string>(changedSettings(values.base, values.effective));
	const rows: SettingRow[] = SETTINGS_TABLE.map((item) => ({
		key: item.name,
		label: item.label,
		value: item.format(values.effective, options.format),
		description: `${item.description} Default: ${item.format(values.base, options.format)}.`,
		...(changed.has(item.key) ? { changed: true } : {}),
		...(item.choices ? { choices: item.choices } : {}),
		...(item.placeholder ? { placeholder: item.placeholder } : {}),
	}));
	const latest = model.timeline.points.at(-1);
	const summary: string[] = [];
	if (latest) summary.push(sizeLine(latest, model.budgetInfo?.budget));
	const info = model.budgetInfo;
	if (info?.overhead !== undefined) summary.push(`Fixed overhead ~${formatTokenCount(info.overhead)} · usable ${formatTokenCount(info.usable ?? 0)}`);
	summary.push(...detailLines(values.effective, model));
	summary.push(`Files mirror ${model.mirrorPath}`);
	return {
		rows,
		summary,
		changed: SETTINGS_TABLE.filter((item) => changed.has(item.key)).map((item) => item.name),
		...(options.warning ? { warning: options.warning } : {}),
	};
}

/**
 * pi's settings-page Size line ("next request ~E of B · last request M (provider count)").
 * pi's "next request" is the estimate of the request built last, here the newest request.
 * The line shows its provider count and the logged estimate side by side. The budget is
 * today's, so after a budget change it is off until the next request.
 */
export function sizeLine(latest: Pick<TimelinePoint, "tokens" | "measured" | "estimated">, budget?: number): string {
	const of = budget !== undefined ? ` of ${formatTokenCount(budget)}` : "";
	if (!latest.measured) return `Size last request ~${formatTokenCount(latest.tokens)}${of} (estimate)`;
	const estimate = latest.estimated !== undefined ? ` · estimated ~${formatTokenCount(latest.estimated)}` : "";
	return `Size last request ${formatTokenCount(latest.tokens)}${of} (provider count)${estimate}`;
}

/**
 * Footer text in the session prompt's right slot, as pi's status line:
 * `clm 12k / 32k · r2` (newest size against the budget in force), `clm off · r2`, or
 * undefined before the session has CLM data.
 */
export function footerText(model: Pick<PanelModel, "found" | "enabled" | "revision" | "timeline" | "budget"> & Partial<Pick<PanelModel, "noticesOnly">>): string | undefined {
	if (!model.found) return undefined;
	if (!model.enabled) return `clm off · r${model.revision}`;
	const mode = model.noticesOnly ? " notices-only" : "";
	const latest = model.timeline.points.at(-1);
	const size = latest === undefined
		? ""
		: ` ${latest.measured ? "" : "~"}${formatTokenCount(latest.tokens)}${model.budget !== undefined ? ` / ${formatTokenCount(model.budget)}` : ""}`;
	return `clm${mode}${size} · r${model.revision}`;
}

/** Key of the settings page's "Reset to defaults" row, and the choice that resets. */
export const RESET_ROW = "reset";
export const RESET_NOW = "reset now";

/**
 * pi's "Reset to defaults" row: Enter cycles to "reset now", which drops this session's
 * changes (the same as `/clm config reset`). With nothing changed Enter does nothing.
 */
export function resetRow(changed: number): SettingRow {
	const value = changed === 0 ? "nothing changed" : `${changed} changed`;
	return {
		key: RESET_ROW,
		label: "Reset to defaults",
		value,
		description: "Drop this session's changes; the plugin options, environment and defaults apply again from the next request. Same as /clm config reset. Enter on \"reset now\" resets at once.",
		choices: changed === 0 ? [value] : [value, RESET_NOW],
	};
}

/**
 * Settings-page details after the size lines (pi's settings summary): calibration, the
 * overflow guard's limit, the steering document with its hash, annotation counts.
 */
export function detailLines(
	effective: SettingsValues,
	model: Pick<PanelModel, "budgetInfo"> & Partial<Pick<PanelModel, "calibration" | "steering" | "annotations">>,
): string[] {
	const lines: string[] = [];
	const calibration = model.calibration;
	if (calibration) {
		lines.push(calibration.samples === 0
			? "Estimate not calibrated yet (characters ÷ 4 until the provider reports a size)"
			: `Estimate ×${calibration.factor.toFixed(2)}, calibrated from ${calibration.samples} provider count${calibration.samples === 1 ? "" : "s"}`);
	}
	if (effective.settings.mode === "notices-only") {
		lines.push(effective.editing
			? "Mode notices-only: budget notices and the guard run; no mirror, the model cannot edit its context"
			: "Mode notices-only (CLM editing is off, so nothing runs)");
	}
	const limit = model.budgetInfo?.limit;
	lines.push(effective.settings.guard === "off"
		? "Guard off"
		: `Guard withholds the oldest tool results above ${limit === undefined ? "budget − reserve" : formatTokenCount(limit)}`);
	// pi appends the native-compaction state; `auto` and `on` leave OpenCode's own config.
	if (effective.settings.compaction === "off") lines[lines.length - 1] += " · OpenCode's automatic compaction off";
	// The hash prefix identifies an experiment arm (compare with sha256sum).
	if (model.steering) lines.push(`Steering ${model.steering.name} (sha256 ${model.steering.hash}…)`);
	const counts = model.annotations;
	if (counts) {
		lines.push(counts.total === 0
			? "Annotations none"
			: `Annotations ${counts.active} continuity/pin · ${counts.archived} archive · ${counts.total} total`);
	}
	return lines;
}

/**
 * The server's base settings, from snapshot.json `base` (the server writes it each
 * request), applied over the TUI's own resolution so non-table settings (mirrorDir…) stay.
 * `tui` when there is no usable snapshot base yet.
 */
export function serverBase(own: ClmSettings, snapshot: unknown): { base: ClmSettings; source: "server" | "tui" } {
	const raw = snapshot && typeof snapshot === "object" ? (snapshot as { base?: unknown }).base : undefined;
	if (!raw || typeof raw !== "object") return { base: own, source: "tui" };
	const { overrides } = sanitizeOverrides(raw);
	try {
		return { base: applyOverrides(own, overrides), source: "server" };
	} catch {
		return { base: own, source: "tui" };
	}
}

/** True when overrides.json (mtime, ms) is newer than snapshot.json's `at`, or there is no snapshot. */
export function overridesNewer(overridesAt: number | undefined, snapshot: unknown): boolean {
	if (overridesAt === undefined) return false;
	const at = snapshot && typeof snapshot === "object" ? (snapshot as { at?: unknown }).at : undefined;
	const snapshotAt = typeof at === "string" ? Date.parse(at) : Number.NaN;
	return !Number.isFinite(snapshotAt) || overridesAt > snapshotAt;
}
