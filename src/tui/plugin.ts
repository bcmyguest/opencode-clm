// TUI side of opencode-clm: the `/clm` panel route, its slash row and palette command,
// the Enter intercept that handles typed `/clm …` lines without a model turn, and live
// reloads while the panel is open. Written for this package (v0.2.0 design §2–§3).

import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";

import { userOwnsStatusCommand } from "../commands.ts";
import { type ClmCommand, type Page } from "../panel/command.ts";
import { changeSetting, overridesValues, resetSettings, sessionValues, showSetting } from "../overrides.ts";
import { COMMAND_EVENT, commandOf, createChannelClient, type ChannelOperation, type ChannelReply } from "../channel.ts";
import { createLocator, resetSession } from "./locator.ts";
import { outsideMessage, resolveSource, sourceOverrides, type FileApi, type SessionSource } from "./remote.ts";
import type { SettingsValues } from "../settings-table.ts";
import { interceptEnter } from "./intercept.ts";
import { buildPanelModel, type PanelModel } from "../panel/model.ts";
import { formatTokenCount } from "../panel/timeline.ts";
import { readSessionDirectory, sessionDirectory, type SessionReader } from "../session-files.ts";
import { resolveSettings, type ClmSettings } from "../settings.ts";
import { fallbackBudget, latestUsage, modelLimits, overridesNewer, serverBase, serverPluginOptions, settingsView } from "./data.ts";
import type { SessionFiles } from "../panel/files.ts";
import { createPanel, type PanelController } from "./panel.ts";

export const PANEL_ROUTE = "opencode-clm.panel";
const OPEN_COMMAND = "opencode-clm.panel.open";
const RELOAD_DEBOUNCE_MS = 250;
/** The package's server entry, to recognise a `file://` spec in the server plugin list. */
const PACKAGE_INDEX_URL = new URL("../../index.ts", import.meta.url).href;

const PAGES = new Set<Page>(["overview", "input", "edits", "settings"]);
/** `/clm path` names how this TUI reads the files. */
const SOURCE_LABEL: Record<SessionSource["kind"], string> = {
	local: "local disk",
	remote: "server file API",
	channel: "server plugin channel",
	outside: "unreadable from this TUI",
};
/** Reads nothing: a session directory the attached TUI cannot reach. */
const NO_READER: SessionReader = { name: "none", isDirectory: async () => false, readText: async () => undefined, list: async () => [], stamp: async () => undefined };

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const tui: TuiPlugin = async (api, tuiOptions) => {
	let active: { controller: PanelController; sessionID: string } | undefined;
	let reloadTimer: ReturnType<typeof setTimeout> | undefined;

	/** Settings as the server resolves them: its plugin entry's options, else this plugin's. */
	const settings = (): ClmSettings => {
		const fromServer = serverPluginOptions(api.state.config.plugin, PACKAGE_INDEX_URL);
		const options = fromServer ?? ((tuiOptions ?? {}) as Record<string, unknown>);
		return resolveSettings(options, process.env, api.state.path.directory);
	};

	// ---- the channel to the server plugin (src/channel.ts) --------------------------------
	const channel = createChannelClient({
		publish: async (command) => {
			const result = await api.client.tui.publish({ body: { type: COMMAND_EVENT, properties: { command } } });
			if (result.error !== undefined) throw new Error(`publishing to the server failed: ${JSON.stringify(result.error)}`);
		},
		subscribe: (handler) => api.event.on(COMMAND_EVENT, (event) => {
			const command = commandOf(event);
			if (command !== undefined) handler(command);
		}),
	});

	/** Sends one operation; throws the server's error text, or a timeout. */
	const ask = async (sessionID: string, operation: ChannelOperation, timeoutMs?: number): Promise<ChannelReply> => {
		const reply = await channel.request(sessionID, operation, timeoutMs);
		if (!reply.ok) throw new Error(reply.text);
		return reply;
	};

	/** Where the server keeps each session's files (`locate`), cached; see locator.ts. */
	const locator = createLocator({ ask });

	/** When this TUI last changed a session's overrides through the channel (no mtime remotely). */
	const channelWrites = new Map<string, number>();

	/** `write`: the source a setting change goes to (never the read-only same-disk guess). */
	const source = (sessionID: string, options: { write?: boolean } = {}): Promise<SessionSource> => resolveSource({
		ownDirectory: sessionDirectory(settings().mirrorDir, sessionID),
		serverRoot: api.state.path.directory,
		file: api.client.file as unknown as FileApi,
		locate: () => locator.locate(sessionID),
		located: () => locator.fresh(sessionID),
		relocate: () => {
			const own = sessionDirectory(settings().mirrorDir, sessionID);
			// The server keeps this session's files elsewhere: show them.
			locator.relocate(sessionID, (value) => {
				if (value.directory !== own) refreshPanel(sessionID);
			});
		},
		ask: (operation) => ask(sessionID, operation),
	}, options);

	const readFiles = async (sessionID: string, from: SessionSource): Promise<SessionFiles> => {
		if (from.kind === "outside") {
			const files = await readSessionDirectory(from.directory, sessionID, NO_READER);
			files.warnings.push(outsideMessage(from));
			return files;
		}
		const files = await readSessionDirectory(from.directory, sessionID, from.reader);
		// A read through the server failed: ask where the files are again next time.
		if (from.kind !== "local" && files.warnings.some((warning) => warning.startsWith("Could not"))) locator.forget(sessionID);
		return files;
	};

	/**
	 * Base and effective settings of a session. The server is the authority on the base:
	 * once it wrote snapshot.json, the base is the server's (`serverBase`), so a TUI whose
	 * environment resolves differently still merges and validates as the server would.
	 * Before the first request, the TUI's own resolution of the server's options stands in.
	 * Editing base = state.json's `enabled`. Effective = base + the session's overrides.json.
	 */
	const sessionSettings = async (sessionID: string, from: SessionSource, files: Pick<SessionFiles, "state" | "snapshot">) => {
		const own = settings();
		const { base, source: baseSource } = serverBase(own, files.snapshot);
		const stored = files.state && typeof files.state === "object" ? (files.state as { enabled?: unknown }).enabled : undefined;
		const baseEditing = typeof stored === "boolean" ? stored : true;
		const read = from.kind === "local"
			? await sessionValues(from.directory, base, baseEditing)
			: overridesValues(await sourceOverrides(from), base, baseEditing, channelWrites.get(sessionID));
		const values: { base: SettingsValues; effective: SettingsValues } = { base: { editing: baseEditing, settings: base }, effective: read.values };
		return { base, baseSource, baseEditing, directory: from.directory, values, ...(read.warning ? { warning: read.warning } : {}), ...(read.mtimeMs !== undefined ? { overridesAt: read.mtimeMs } : {}) };
	};

	const loadModel = async (sessionID: string): Promise<PanelModel> => {
		const from = await source(sessionID);
		const files = await readFiles(sessionID, from);
		const messages = api.state.session.messages(sessionID);
		const latest = latestUsage(messages);
		const limits = modelLimits(messages, api.state.provider);
		const current = await sessionSettings(sessionID, from, files);
		const budget = fallbackBudget(current.values.effective.settings, limits);
		// overrides.json written after the last request: its budget is in force from the next
		// request, so the panel shows it rather than the snapshot's.
		const preferSettings = overridesNewer(current.overridesAt, files.snapshot);
		const model = buildPanelModel(files, { ...(latest ? { latest } : {}), ...(budget ? { budget } : {}), ...(preferSettings ? { preferSettings } : {}) });
		model.enabled = current.values.effective.editing;
		model.settings = settingsView(current.values, model, {
			format: { ...(limits.context ? { modelWindow: limits.context } : {}) },
			...(current.warning ? { warning: current.warning } : {}),
		});
		return model;
	};

	/**
	 * Validates and saves one setting; returns `Label: value` and whether the server
	 * confirmed it with its own toast. Local files: written here (overrides.json, which the
	 * server reads before each request). Otherwise the server applies it over the channel.
	 */
	const applySetting = async (sessionID: string, name: string, value: string): Promise<{ text: string; viaServer: boolean }> => {
		const from = await source(sessionID, { write: true });
		if (from.kind !== "local") {
			const reply = await ask(sessionID, { op: "set", setting: name, value });
			channelWrites.set(sessionID, Date.now());
			return { text: reply.text, viaServer: true };
		}
		const files = await readFiles(sessionID, from);
		const current = await sessionSettings(sessionID, from, files);
		const result = await changeSetting({
			sessionDirectory: current.directory,
			base: current.base,
			baseEditing: current.baseEditing,
			projectDirectory: api.state.path.directory,
		}, name, value);
		return { text: result.text, viaServer: false };
	};

	/** False when `/clm` belongs to someone else: `commands: false`, or a user-defined command. */
	const owned = (): boolean => {
		if (!settings().commands) return false;
		return !userOwnsStatusCommand((api.state.config as { command?: unknown }).command);
	};

	const currentSessionID = (): string | undefined => {
		const route = api.route.current;
		if (route.name === "session" && route.params && typeof route.params.sessionID === "string") return route.params.sessionID;
		if (route.name === PANEL_ROUTE) return active?.sessionID;
		return undefined;
	};

	const open = (page: Page) => {
		const sessionID = currentSessionID();
		if (!sessionID) {
			api.ui.toast({ variant: "warning", title: "CLM", message: "Open a session first." });
			return;
		}
		if (active && active.sessionID === sessionID && api.route.current.name === PANEL_ROUTE) {
			active.controller.setPage(page);
			return;
		}
		api.route.navigate(PANEL_ROUTE, { sessionID, page });
	};

	api.route.register([{
		name: PANEL_ROUTE,
		render: ({ params }) => {
			const sessionID = typeof params?.sessionID === "string" ? params.sessionID : "";
			const page = typeof params?.page === "string" && PAGES.has(params.page as Page) ? (params.page as Page) : "overview";
			active?.controller.dispose();
			const controller = createPanel(api, {
				page,
				load: () => loadModel(sessionID).catch((error: unknown) => errorModel(sessionID, error)),
				apply: async (setting, value) => {
					try {
						await applySetting(sessionID, setting, value);
						return undefined;
					} catch (error) {
						return describe(error);
					}
				},
				onDispose: () => {
					if (active?.controller === controller) active = undefined;
				},
				onClose: () => {
					if (active?.controller === controller) active = undefined;
					if (sessionID) api.route.navigate("session", { sessionID });
					else api.route.navigate("home");
				},
			});
			active = { controller, sessionID };
			// A raw renderable is accepted by the host's Solid insert (verified with 1.18.34).
			return controller.renderable as unknown as ReturnType<Parameters<TuiPluginApi["route"]["register"]>[0][number]["render"]>;
		},
	}]);

	const disposeLayer = api.keymap.registerLayer({
		commands: [{
			name: OPEN_COMMAND,
			title: "CLM panel",
			desc: "Context size, input, edits and settings of CLM",
			namespace: "palette",
			slashName: "clm",
			run() {
				open("overview");
			},
		}],
	});

	const toast = (message: string, variant: "info" | "warning" = "info") =>
		api.ui.toast({ variant, title: "CLM", message });

	/** After a change: refresh an open panel so it shows the new value. */
	const refreshPanel = (sessionID: string) => {
		if (active?.sessionID === sessionID) void active.controller.reload();
	};

	/** Every `/clm …` line the intercept consumes (`/clm reset` goes to the server over the channel). */
	const handle = async (command: ClmCommand): Promise<void> => {
		if (command.kind === "open") {
			open(command.page);
			return;
		}
		if (command.kind === "usage") {
			toast(command.text, "warning");
			return;
		}
		const sessionID = currentSessionID();
		if (!sessionID) {
			toast("Open a session first.", "warning");
			return;
		}
		switch (command.kind) {
			case "path": {
				const from = await source(sessionID);
				toast(`${from.directory} (${SOURCE_LABEL[from.kind]})`);
				return;
			}
			case "status":
				toast(statusSummary(await loadModel(sessionID)));
				return;
			case "config-show": {
				const from = await source(sessionID);
				const current = await sessionSettings(sessionID, from, await readFiles(sessionID, from));
				toast(showSetting(command.setting, current.values.effective));
				return;
			}
			case "config-set":
				try {
					const result = await applySetting(sessionID, command.setting, command.value);
					if (!result.viaServer) toast(`CLM ${result.text}.`);
				} catch (error) {
					toast(describe(error), "warning");
				}
				refreshPanel(sessionID);
				return;
			case "config-reset": {
				const from = await source(sessionID, { write: true });
				if (from.kind === "local") {
					await resetSettings(from.directory);
					toast("CLM settings reset to the defaults.");
				} else {
					await ask(sessionID, { op: "settings-reset" });
					channelWrites.set(sessionID, Date.now());
				}
				refreshPanel(sessionID);
				return;
			}
			case "enable": {
				// The same override as the server's `/clm on|off` and `/clm config editing`.
				const result = await applySetting(sessionID, "editing", command.enabled ? "on" : "off");
				if (!result.viaServer) toast(`CLM ${command.enabled ? "on" : "off"} for this session`);
				refreshPanel(sessionID);
				return;
			}
			case "server":
				// `/clm reset`: the server owns state.json; it drops the revision and toasts.
				await resetSession({
					sessionID,
					ask,
					command: (parameters) => api.client.session.command(parameters),
					toast,
				});
				refreshPanel(sessionID);
				return;
		}
	};

	const disposeIntercept = api.keymap.intercept("key", (context) => {
		interceptEnter(context as never, {
			focused: () => api.renderer.currentFocusedRenderable as never,
			owned,
			handle,
			serverChannel: () => true,
			report: (message) => toast(message, "warning"),
		});
	}, { priority: 100 });

	const scheduleReload = (sessionID: unknown) => {
		if (!active || (typeof sessionID === "string" && sessionID !== active.sessionID)) return;
		clearTimeout(reloadTimer);
		reloadTimer = setTimeout(() => void active?.controller.reload(), RELOAD_DEBOUNCE_MS);
	};
	const offIdle = api.event.on("session.idle", (event) => scheduleReload((event.properties as { sessionID?: unknown }).sessionID));
	const offMessage = api.event.on("message.updated", (event) =>
		scheduleReload((event.properties as { info?: { sessionID?: unknown } }).info?.sessionID));

	api.lifecycle.onDispose(() => {
		clearTimeout(reloadTimer);
		active?.controller.dispose();
		active = undefined;
		offIdle();
		offMessage();
		channel.dispose();
		disposeIntercept();
		disposeLayer();
	});
};

/** A model that shows the read error on the overview instead of a broken panel. */
function errorModel(sessionID: string, error: unknown): PanelModel {
	return {
		sessionID,
		directory: "(unknown)",
		found: false,
		enabled: true,
		revision: 0,
		timeline: { points: [], markers: [], peakTokens: 0, turnStarts: [] },
		revisions: [],
		settings: { rows: [], summary: [], changed: [] },
		mirrorPath: "",
		warnings: [`Could not load the CLM files: ${describe(error)}`],
	};
}

/** Toast text for `/clm status` typed in the TUI. */
export function statusSummary(model: PanelModel): string {
	if (!model.found) return `No CLM data for this session (${model.directory}).`;
	const latest = model.timeline.points.at(-1);
	const parts = [
		`CLM ${model.enabled ? "on" : "off"} · revision ${model.revision}`,
		latest ? `last request ${latest.measured ? "" : "~"}${formatTokenCount(latest.tokens)}` : "no requests yet",
		model.budget !== undefined ? `budget ${formatTokenCount(model.budget)}` : undefined,
		model.budgetInfo?.overhead !== undefined ? `fixed overhead ~${formatTokenCount(model.budgetInfo.overhead)}` : undefined,
		model.lastOutcome ? `last: ${model.lastOutcome.kind}` : undefined,
	];
	return parts.filter(Boolean).join(" · ");
}
