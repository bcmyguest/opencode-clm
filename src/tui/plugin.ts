// TUI side of opencode-clm: the `/clm` panel route, its slash row and palette command,
// the Enter intercept that handles typed `/clm …` lines without a model turn, and live
// reloads while the panel is open. Written for this package (v0.2.0 design §2–§3).

import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";

import { parseClmCommand, type ClmCommand, type Page } from "../panel/command.ts";
import { buildPanelModel, type PanelModel } from "../panel/model.ts";
import { formatTokenCount } from "../panel/timeline.ts";
import { readSessionFiles, sessionDirectory } from "../session-files.ts";
import { resolveSettings, type ClmSettings } from "../settings.ts";
import { fallbackBudget, latestUsage, modelLimits, serverPluginOptions, settingsView } from "./data.ts";
import { createPanel, type PanelController } from "./panel.ts";

export const PANEL_ROUTE = "opencode-clm.panel";
const OPEN_COMMAND = "opencode-clm.panel.open";
const RELOAD_DEBOUNCE_MS = 250;
/** The package's server entry, to recognise a `file://` spec in the server plugin list. */
const PACKAGE_INDEX_URL = new URL("../../index.ts", import.meta.url).href;

const PAGES = new Set<Page>(["overview", "input", "edits", "settings"]);

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

	const loadModel = async (sessionID: string): Promise<PanelModel> => {
		const resolved = settings();
		const files = await readSessionFiles(resolved.mirrorDir, sessionID);
		const messages = api.state.session.messages(sessionID);
		const latest = latestUsage(messages);
		const budget = fallbackBudget(resolved, modelLimits(messages, api.state.provider));
		const model = buildPanelModel(files, { ...(latest ? { latest } : {}), ...(budget ? { budget } : {}) });
		model.settings = settingsView(resolved, model);
		return model;
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
				apply: async (setting) =>
					`Changing ${setting} from the panel arrives with /clm config; the value in effect is kept.`,
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

	/** Returns false when the line must reach the server command instead. */
	const handle = async (command: ClmCommand): Promise<boolean> => {
		switch (command.kind) {
			case "open":
				open(command.page);
				return true;
			case "usage":
				toast(command.text, "warning");
				return true;
			case "path": {
				const sessionID = currentSessionID();
				if (!sessionID) toast("Open a session first.", "warning");
				else toast(sessionDirectory(settings().mirrorDir, sessionID));
				return true;
			}
			case "status": {
				const sessionID = currentSessionID();
				if (!sessionID) {
					toast("Open a session first.", "warning");
					return true;
				}
				toast(statusSummary(await loadModel(sessionID)));
				return true;
			}
			case "config-show":
			case "config-set":
			case "config-reset":
				toast("/clm config arrives in the next release step; open the settings page with /clm settings.", "warning");
				return true;
			case "enable":
			case "server":
				// The server command owns state.json (on/off and reset rewrite it).
				return false;
		}
	};

	const disposeIntercept = api.keymap.intercept("key", (context) => {
		const event = context.event;
		if (event.name !== "return" || event.shift || event.ctrl || event.meta) return;
		const focused = api.renderer.currentFocusedRenderable as unknown as { plainText?: unknown; setText?: (text: string) => void } | null;
		if (!focused || typeof focused.plainText !== "string" || typeof focused.setText !== "function") return;
		const command = parseClmCommand(focused.plainText);
		if (!command || command.kind === "server" || command.kind === "enable") return;
		context.consume();
		focused.setText("");
		void handle(command).catch((error: unknown) => toast(`CLM: ${describe(error)}`, "warning"));
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
