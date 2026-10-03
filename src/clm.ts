/**
 * The CLM lifecycle for one OpenCode session, independent of the plugin API so it can be
 * unit tested. Ported from pi-clm src/index.ts (`context` and `turn_end` handlers; MIT,
 * Copyright 2026 Emanuel Casco).
 *
 * Timing differs from pi-clm: OpenCode has no `turn_end` hook, so the edit the model made
 * during step k is read back and committed at the start of step k+1's transform, right
 * before the request it affects. As in pi-clm, the file content at that moment wins.
 *
 *   transform(raw)  0. pinned = everything up to and including the first user message;
 *                      source = flatten(rest), the raw prefix a checkpoint digests
 *                   1. commit: read the mirror; if it differs from the last render,
 *                      apply it (edit gate) and save a new checkpoint over that render's source
 *                   2. project: checkpoint.projected ++ source suffix; after a compaction,
 *                      rebase onto the summarized history; on any other mismatch, reset
 *                   3. reasoning view, observation cap, overflow guard (new suffix only)
 *                   4. render the effective context to the mirror
 *                   5. notices: edit outcome, reset, overflow, continuity size, budget tier
 *                   6. output: pinned ++ unflatten(effective) ++ continuity ++ notices
 *
 * Anchor: a checkpoint digests the flattened source with tool-result content left out
 * (projection.ts), so OpenCode's prune does not discard it. The same rule means any other
 * change to a stored tool output inside the covered prefix also goes undetected. For a
 * pruned output the accepted revision keeps the text the model saw, in the request too:
 * `unflatten` sends it with the revision's text, so request, mirror and estimate agree.
 * An output rewritten by another plugin or an SDK client is not restored: the request
 * carries the new text while the mirror and estimate keep the revision's.
 *
 * Measurement: one estimator, chars/4 × `estimateFactor`, then × the calibration factor.
 * The edit gate, the overflow guard and the budget reading all use it, in tokens, and all
 * count the system prompt and tool schemas once `scope` holds their sizes. The
 * calibrator learns only from requests whose full scope (system prompt and tool schemas
 * included) was estimated; without those sizes it stays at 1.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	budgetNoticeText,
	budgetTiers,
	BudgetTracker,
	EstimateCalibrator,
	formatTokens,
	resolveBudget,
	type BudgetReading,
} from "./budget.ts";
import { applyContextDocument, renderContextDocument, renderMessage } from "./context-document.ts";
import {
	AnnotationStore,
	ContinuitySizeTracker,
	continuitySizeNoticeText,
	formatContinuityMessage,
	type ContinuityBlockSource,
	type LiveContextAnnotation,
} from "./continuity.ts";
import { classifyMirrorToolCall } from "./mirror-guard.ts";
import { MirrorStore } from "./mirror-store.ts";
import { capObservations } from "./observation.ts";
import { flatten, noteMessage, unflatten, withoutReasoning, type OcInfo, type OcMessage } from "./opencode.ts";
import { applyOverflowGuard, overflowGuardLimit, overflowNoticeText } from "./overflow.ts";
import type { ClmStatus } from "./presentation.ts";
import { applyProjection, createProjectionCheckpoint, type ProjectionCheckpoint } from "./projection.ts";
import type { ClmSettings } from "./settings.ts";
import {
	loadLiveContextState,
	resetProjectionState,
	saveLiveContextState,
	type LiveContextState,
} from "./state.ts";
import type { SteeringDocument } from "./steering.ts";
import type { ContextDocumentSnapshot, LiveContextMessage, TurnBaseline } from "./types.ts";

export interface ModelLimits {
	/** Model context window, tokens. */
	context?: number;
	/** Model output limit, tokens; subtracted from the window by `resolveBudget`. */
	output?: number;
}

/** Sizes of the request parts the plugin does not see in the messages hook. */
export interface RequestScope {
	/** Estimated tokens of the system prompt (from `experimental.chat.system.transform`). */
	systemTokens?: number;
	/** Estimated tokens of the tool schemas (from `tool.definition`). */
	toolTokens?: number;
}

export interface TransformResult {
	/** The messages to send; the caller writes them into OpenCode's array in place. */
	messages: OcMessage[];
	/** Notices appended to this request (also inside `messages`, as one user note). */
	notices: string[];
	/** Calibrated estimate of this request, tokens (system prompt and tool schemas included when known); undefined when CLM did not run. */
	estimated?: number;
	reading?: BudgetReading;
}

export interface MirrorCheck {
	changed: boolean;
	accepted: boolean;
	message: string;
}

interface Baseline extends TurnBaseline {
	/** Fit-gate limit for an edit of this render, tokens (guard limit net of the pinned task and continuity). */
	limit?: number;
}

/** OpenCode session ids are `ses_` plus base62; anything else would alias another directory. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const CHARS_PER_TOKEN = 4;

/** Index after the pinned prefix: everything up to and including the first user message. */
export function pinnedCount(raw: readonly OcMessage[]): number {
	const first = raw.findIndex((message) => message.info.role === "user");
	return first < 0 ? 0 : first + 1;
}

export interface ObservedRequest {
	tokens: number;
	/** Position of the reporting assistant message in the raw OpenCode history. */
	index: number;
	messageID: string;
}

/**
 * Provider-reported input of the newest successful request: the newest assistant message
 * without an error and not a compaction summary, with input + cache read + cache write > 0.
 */
export function lastProviderReported(raw: readonly OcMessage[]): ObservedRequest | undefined {
	for (let index = raw.length - 1; index >= 0; index--) {
		const info = raw[index]!.info;
		if (info.role !== "assistant" || info.error || info.summary || !info.tokens) continue;
		const tokens = info.tokens;
		const total = Number(tokens.input ?? 0) + Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0);
		if (Number.isFinite(total) && total > 0) return { tokens: total, index, messageID: info.id };
	}
	return undefined;
}

/** Id of the newest compaction summary (an assistant message with `summary` set). */
export function compactionSummaryId(raw: readonly OcMessage[]): string | undefined {
	for (let index = raw.length - 1; index >= 0; index--) {
		const info = raw[index]!.info;
		if (info.role === "assistant" && info.summary && !info.error) return info.id;
	}
	return undefined;
}

/** Asks OpenCode's summarizer to carry the plugin's annotations through a compaction. */
export const COMPACTION_INSTRUCTION =
	"CLM note for the summary: copy every pin and continuity annotation listed below " +
	"(id, title, Why, Next, pinned source text) into the summary word for word. " +
	"Do not shorten, merge or reword them.";

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ClmSession {
	readonly tracker = new BudgetTracker();
	readonly calibrator = new EstimateCalibrator();
	readonly continuitySize = new ContinuitySizeTracker();
	readonly annotations: AnnotationStore;
	state: LiveContextState;
	/** Set when `state.json` existed but could not be used (the session then starts clean). */
	readonly loadWarning?: string;
	accepted = 0;
	rejected = 0;
	limits: ModelLimits = {};
	scope: RequestScope = {};
	/** Set by `experimental.session.compacting`: the next transform carries OpenCode's compaction input. */
	compacting = false;
	/**
	 * Set when OpenCode reports a finished compaction (`session.compacted` event or the
	 * `experimental.compaction.autocontinue` hook); the next transform rebases onto the summary.
	 */
	compacted = false;
	/** What the last transform rendered; the next transform commits the mirror against it. */
	baseline?: Baseline;
	/** The snapshot now in the mirror file; continuity tools resolve block ids against it. */
	lastSnapshot?: ContextDocumentSnapshot;
	lastReading?: BudgetReading;
	lastRequest?: { rawMessages: number; sentMessages: number; mirrorBlocks: number };
	requests = 0;

	private pendingNotices: string[] = [];
	private invalidationStreak = 0;
	/**
	 * Per-process seed of the stable document id. Fresh on every open, so a document id never
	 * repeats even when a corrupt state file resets the revision counter to 0.
	 */
	private readonly nonce = randomUUID();
	private readonly tokenCache = new WeakMap<LiveContextMessage, number>();
	private saving: Promise<void> = Promise.resolve();
	private running: Promise<unknown> = Promise.resolve();

	private constructor(
		readonly sessionID: string,
		readonly store: MirrorStore,
		readonly settings: ClmSettings,
		loaded: { state: LiveContextState; warning?: string },
	) {
		this.state = loaded.state;
		this.loadWarning = loaded.warning;
		this.annotations = new AnnotationStore(store.directory, { estimateTokens: (text) => this.textTokens(text) });
	}

	/** Open (or resume) the session directory `<mirrorDir>/clm-<sessionID>/`. */
	static async open(sessionID: string, settings: ClmSettings): Promise<ClmSession> {
		if (!SESSION_ID_RE.test(sessionID)) throw new Error(`Invalid session id for CLM: ${JSON.stringify(sessionID)}`);
		const store = await MirrorStore.create(sessionID, settings.mirrorDir);
		const loaded = await loadLiveContextState(store.directory);
		const session = new ClmSession(sessionID, store, settings, loaded);
		if (loaded.warning) await session.log({ event: "state-warning", warning: loaded.warning });
		return session;
	}

	get mirrorPath(): string {
		return this.store.filePath;
	}

	// ---- measurement -------------------------------------------------------------------

	/** Uncalibrated tokens of a text: chars/4 × estimateFactor. */
	textTokens(text: string): number {
		return Math.ceil((text.length / CHARS_PER_TOKEN) * this.settings.estimateFactor);
	}

	/** Uncalibrated tokens of messages, cached per message object. */
	rawTokens(messages: readonly LiveContextMessage[]): number {
		let total = 0;
		for (const message of messages) {
			let tokens = this.tokenCache.get(message);
			if (tokens === undefined) {
				tokens = this.textTokens(renderMessage(message));
				this.tokenCache.set(message, tokens);
			}
			total += tokens;
		}
		return total;
	}

	/** Calibrated tokens: the single estimator for gate, guard and budget. */
	estimate = (messages: LiveContextMessage[]): number => this.calibrator.apply(this.rawTokens(messages));

	private noticeTokens(notices: readonly string[]): number {
		return notices.reduce((total, notice) => total + this.textTokens(notice), 0);
	}

	resolvedBudget() {
		return resolveBudget(this.settings.budget, this.limits.context, this.limits.output);
	}

	/** budget − reserve, or undefined while the budget is unknown. */
	guardLimit(): number | undefined {
		const resolved = this.resolvedBudget();
		return resolved ? overflowGuardLimit(resolved.budget, resolved.reserve) : undefined;
	}

	// ---- persistence -------------------------------------------------------------------

	/**
	 * Every state change goes through this queue: the next state is computed from the
	 * current one, saved, then activated, one change at a time. So the last rename always
	 * holds the newest state, and concurrent callers (a command during a transform) never
	 * build on a stale state. A failed save throws and leaves the state unchanged, unless
	 * `activateOnFailure` is set (outcomes and resets: in-memory state must move on).
	 */
	private updateState(
		change: (state: LiveContextState) => LiveContextState,
		activateOnFailure = false,
	): Promise<LiveContextState> {
		const run = this.saving.then(async () => {
			const next = change(this.state);
			try {
				await saveLiveContextState(this.store.directory, next);
			} catch (error) {
				if (activateOnFailure) this.state = next;
				await this.log({ event: "save-failed", revision: next.revision, error: describe(error) });
				throw error;
			}
			this.state = next;
			return next;
		});
		this.saving = run.then(() => undefined, () => undefined);
		return run;
	}

	/** One JSON line per event in `<session dir>/events.jsonl`. Best effort. */
	async log(event: Record<string, unknown>): Promise<void> {
		const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
		await appendFile(join(this.store.directory, "events.jsonl"), line, { mode: 0o600 }).catch(() => undefined);
	}

	async setEnabled(enabled: boolean): Promise<void> {
		await this.updateState((state) => ({ ...state, enabled }));
		this.baseline = undefined;
		if (!enabled) this.continuitySize.observe(0);
	}

	/** Drop the accepted revision (e.g. `/clm reset`); the next request sends the raw history. */
	async resetProjection(reason: string): Promise<void> {
		const next = await this.updateState((state) => resetProjectionState(state, reason));
		this.baseline = undefined;
		this.tracker.reset();
		this.continuitySize.reset();
		await this.log({ event: "reset", revision: next.revision, reason });
	}

	// ---- edit validation ---------------------------------------------------------------

	private applyOptions(baseline: Baseline) {
		return {
			editingMode: "clm" as const,
			gate: this.settings.gate,
			limit: baseline.limit,
			taskPinned: true,
			estimate: this.estimate,
			estimateUnit: "tokens" as const,
		};
	}

	/** Dry-run validation of mirror text against the last render (receipts). */
	validateMirror(text: string | undefined): MirrorCheck | undefined {
		const baseline = this.baseline;
		if (!baseline || text === undefined) return undefined;
		if (text.trim() === baseline.snapshot.text.trim()) return { changed: false, accepted: true, message: "unchanged" };
		const result = applyContextDocument(text, baseline.snapshot, this.applyOptions(baseline));
		if (!result.accepted) return { changed: true, accepted: false, message: result.reason ?? "refused" };
		const touched = (result.editTrace?.sources ?? [])
			.filter((source) => source.kind !== "kept")
			.map((source) => `${source.sourceIndex + 1} ${baseline.snapshot.blocks[source.sourceIndex]?.role ?? "?"} ${source.kind}`);
		const added = result.editTrace?.additions.length ?? 0;
		const parts = [`about ${formatTokens(result.beforeEstimate)} → ${formatTokens(result.afterEstimate)} tokens`];
		if (touched.length > 0) parts.push(`blocks ${touched.join(", ")}`);
		if (added > 0) parts.push(`${added} new block${added === 1 ? "" : "s"}`);
		const grew = result.afterEstimate > result.beforeEstimate ? " The context grows with this edit." : "";
		const notes = result.diagnostics.length > 0 ? ` ${result.diagnostics.join(" ")}` : "";
		return { changed: true, accepted: true, message: `${parts.join("; ")}.${grew}${notes}` };
	}

	/**
	 * Verdict appended to the result of a tool call that wrote the mirror; undefined for
	 * calls that only read it or do not touch it.
	 */
	receipt(tool: string, args: Record<string, unknown> | undefined, cwd: string): string | undefined {
		if (!this.settings.enabled || !this.state.enabled) return undefined;
		if (classifyMirrorToolCall(tool, args ?? {}, cwd, this.mirrorPath) !== "write") return undefined;
		const check = this.validateMirror(this.store.readSync());
		if (!check) return undefined;
		if (!check.changed) return "[CLM] Mirror unchanged: the file still matches the last render.";
		return check.accepted
			? `[CLM] Mirror edit valid: ${check.message} It applies from your next request.`
			: `[CLM] Mirror edit would be refused: ${check.message} Correct the file before this step ends, or the context stays as it is.`;
	}

	/** The mirror block the model last saw, for continuity annotations. */
	blockSource(blockId: string): ContinuityBlockSource | undefined {
		const snapshot = this.lastSnapshot;
		const block = snapshot?.blocks.find((candidate) => candidate.id === blockId);
		return snapshot && block ? { message: block.source, revision: snapshot.revision } : undefined;
	}

	/** Step 1: commit the edit made since the last render. */
	private async commit(): Promise<void> {
		const baseline = this.baseline;
		this.baseline = undefined;
		if (!baseline || baseline.snapshot.revision !== this.state.revision) return;
		let text: string | undefined;
		try {
			text = await this.store.read();
		} catch (error) {
			this.pendingNotices.push(`[CLM] Could not read the mirror: ${describe(error)}`);
			return;
		}
		if (text === undefined || text.trim() === baseline.snapshot.text.trim()) return;
		const result = applyContextDocument(text, baseline.snapshot, this.applyOptions(baseline));
		const at = new Date().toISOString();
		const sizes = { beforeEstimate: result.beforeEstimate, afterEstimate: result.afterEstimate, estimateUnit: "tokens" as const };
		const reject = async (reason: string) => {
			this.rejected += 1;
			await this.updateState((state) => ({ ...state, lastOutcome: { kind: "rejected", message: reason, ...sizes, at } }), true)
				.catch(() => undefined);
			this.pendingNotices.push(`[CLM] Edit rejected; the context is unchanged. ${reason}`);
			await this.log({ event: "rejected", revision: this.state.revision, reason });
		};
		if (!result.accepted) return reject(result.reason ?? "Context edit rejected.");
		if (!result.changed) return;

		const revision = this.state.revision + 1;
		// state.ts requires editTrace.sourceMessageCount === checkpoint.sourceMessageCount.
		// The trace counts rendered blocks (projection + suffix), the checkpoint counts raw
		// source messages; they differ once an earlier revision is active, so the trace is
		// then kept in events.jsonl only.
		const trace = result.editTrace;
		const traceFits = trace !== undefined && trace.sourceMessageCount === baseline.rawMessages.length;
		let checkpoint: ProjectionCheckpoint;
		try {
			checkpoint = createProjectionCheckpoint({
				revision,
				sourceMessages: baseline.rawMessages,
				projectedMessages: result.messages,
				...sizes,
				createdAt: at,
				...(traceFits ? { editTrace: trace } : {}),
			});
		} catch (error) {
			return reject(`The edited context cannot be saved: ${describe(error)}`);
		}
		const applied = `Applied revision ${revision}: editable context about ${formatTokens(result.beforeEstimate)} → ${formatTokens(result.afterEstimate)} tokens.`;
		try {
			await this.updateState((state) => {
				if (state.revision + 1 !== revision) throw new Error("the session state changed while the edit was applied");
				return {
					version: 1,
					enabled: state.enabled,
					revision,
					checkpoint,
					lastOutcome: { kind: "applied", message: applied, ...sizes, at },
				};
			});
		} catch (error) {
			// Persist before activate: an unsaved revision would vanish on restart.
			this.pendingNotices.push(`[CLM] Revision ${revision} was not applied: it could not be saved (${describe(error)}); the previous context stays in effect.`);
			return;
		}
		this.accepted += 1;
		const revisions = join(this.store.directory, "revisions");
		await mkdir(revisions, { recursive: true, mode: 0o700 }).catch(() => undefined);
		await writeFile(join(revisions, `r${revision}.md`), text, { mode: 0o600 }).catch(() => undefined);
		const notes = result.diagnostics.length > 0 ? ` ${result.diagnostics.join(" ")}` : "";
		this.pendingNotices.push(`[CLM] ${applied}${notes}`);
		await this.log({
			event: "accepted",
			revision,
			before: result.beforeEstimate,
			after: result.afterEstimate,
			trace: trace
				? {
					sourceCount: trace.sourceMessageCount,
					kept: trace.sources.filter((source) => source.kind === "kept").length,
					edited: trace.sources.filter((source) => source.kind === "edited" || source.kind === "normalized").length,
					removed: trace.sources.filter((source) => source.kind === "removed").length,
					restored: trace.sources.filter((source) => source.kind === "restored").length,
					added: trace.additions.length,
					stored: traceFits,
				}
				: undefined,
		});
	}

	// ---- the transform -----------------------------------------------------------------

	/** Transforms of one session run one at a time. */
	transform(raw: OcMessage[]): Promise<TransformResult> {
		const run = this.running.then(() => this.transformNow(raw));
		this.running = run.catch(() => undefined);
		return run;
	}

	private context(raw: readonly OcMessage[]) {
		const rawById = new Map(raw.map((message) => [message.info.id, message]));
		const template = [...raw].reverse().find((message) => message.info.role === "user")?.info as OcInfo | undefined;
		return { sessionID: this.sessionID, rawById, template };
	}

	/** Text for `experimental.session.compacting`'s `output.context`: the instruction plus the active annotations. */
	async compactionContext(): Promise<string | undefined> {
		if (!this.settings.enabled || !this.state.enabled) return undefined;
		const continuity = formatContinuityMessage({ annotations: await this.loadAnnotations(), effectiveMessages: [] });
		return continuity ? `${COMPACTION_INSTRUCTION}\n\n${continuity}` : COMPACTION_INSTRUCTION;
	}

	/**
	 * After a compaction the history starts at the summary, which the compacting transform
	 * built from the accepted revision. Start a fresh baseline there: the revision number
	 * moves on, the checkpoint goes, and the model gets no drop note.
	 */
	private async rebaseAfterCompaction(summaryId: string): Promise<void> {
		const previous = this.state.checkpoint?.revision;
		const message = `Rebased on compaction summary ${summaryId}.`;
		const at = new Date().toISOString();
		let written = true;
		const next = await this.updateState((state) => ({
			version: 1,
			enabled: state.enabled,
			revision: state.revision + 1,
			lastOutcome: { kind: "compacted", message, at },
		}), true).catch(() => {
			written = false;
			return this.state;
		});
		this.invalidationStreak = 0;
		this.tracker.reset();
		await this.log({ event: "compacted", revision: next.revision, previous, summary: summaryId, written });
	}

	private async loadAnnotations(): Promise<LiveContextAnnotation[]> {
		try {
			return await this.annotations.list();
		} catch (error) {
			await this.log({ event: "annotations-unreadable", error: describe(error) });
			return [];
		}
	}

	private async transformNow(raw: OcMessage[]): Promise<TransformResult> {
		if (!this.settings.enabled || !this.state.enabled) {
			this.baseline = undefined;
			this.compacting = false;
			return { messages: raw, notices: [] };
		}
		const pinned = pinnedCount(raw);
		const pinnedMessages = raw.slice(0, pinned);
		const context = this.context(raw);

		// OpenCode's compaction passes a head slice of the history through this hook. Apply
		// the accepted revision when it still covers that slice; never commit, render,
		// notify or reset (the slice is shorter than the history the checkpoint covers).
		if (this.compacting) {
			this.compacting = false;
			const projection = applyProjection(flatten(raw.slice(pinned)), this.state.checkpoint);
			if (!projection.valid || !this.state.checkpoint) return { messages: raw, notices: [] };
			return { messages: [...pinnedMessages, ...unflatten(projection.messages, context)], notices: [] };
		}

		await this.commit();
		this.requests += 1;
		const compacted = this.compacted;
		this.compacted = false;

		// The raw source prefix is digested as flattened, before any view, cap or guard.
		const source = flatten(raw.slice(pinned));
		const observed = lastProviderReported(raw);
		this.calibrator.observe(observed);

		let projection = applyProjection(source, this.state.checkpoint);
		// A late or repeated compaction signal must not swallow a later revert: rebase only
		// onto a summary the active checkpoint does not already cover.
		const summaryId = compacted ? compactionSummaryId(raw) : undefined;
		const rebase = summaryId !== undefined && !projection.valid && this.state.checkpoint !== undefined &&
			!this.state.checkpoint.sourceIds.includes(summaryId);
		if (rebase) {
			await this.rebaseAfterCompaction(summaryId);
			projection = applyProjection(source, undefined);
		} else if (!projection.valid) {
			const dropped = this.state.checkpoint?.revision;
			this.invalidationStreak += 1;
			const reason = projection.reason;
			await this.updateState((state) => resetProjectionState(state, reason), true).catch(() => undefined);
			let notice = `[CLM] Revision ${dropped} was dropped because OpenCode's history changed under it: ${projection.reason} The mirror now shows the stored history.`;
			if (this.invalidationStreak >= 2) {
				notice += " This happened on consecutive requests; edits keep being dropped until the start of the history stops changing.";
			}
			this.pendingNotices.push(notice);
			await this.log({ event: "projection-reset", revision: dropped, reason: projection.reason });
			projection = applyProjection(source, undefined);
		} else if (this.state.checkpoint) {
			this.invalidationStreak = 0;
		}
		const checkpoint = this.state.checkpoint;
		const suffixLength = projection.valid ? projection.suffix.length : 0;

		let effective = projection.messages;
		if (!this.settings.reasoning) effective = withoutReasoning(effective);
		effective = capObservations(effective, this.settings.observationCap);

		const annotations = await this.loadAnnotations();
		const continuityText = (messages: LiveContextMessage[]) =>
			formatContinuityMessage({ annotations, effectiveMessages: messages });
		const pinnedTokens = this.estimate(flatten(pinnedMessages));
		const resolved = this.resolvedBudget();
		const limit = resolved ? overflowGuardLimit(resolved.budget, resolved.reserve) : undefined;
		// System prompt and tool schemas, when the hooks reported them (one request late).
		const { systemTokens, toolTokens } = this.scope;
		const scopeTokens = this.calibrator.apply((systemTokens ?? 0) + (toolTokens ?? 0));
		const excluded = [
			...(systemTokens === undefined ? ["the system prompt"] : []),
			...(toolTokens === undefined ? ["tool schemas"] : []),
		];

		let withheldCount = 0;
		if (this.settings.guard === "withhold" && limit !== undefined) {
			const before = continuityText(effective);
			const fixedTokens = pinnedTokens + scopeTokens +
				this.calibrator.apply((before ? this.textTokens(before) : 0) + this.noticeTokens(this.pendingNotices));
			const guarded = applyOverflowGuard(effective, {
				limit,
				fixedTokens,
				estimate: this.estimate,
				saveDirectory: join(this.store.directory, "withheld"),
				// The model's accepted context is respected; only the new raw suffix is withheld.
				protectBefore: checkpoint ? effective.length - suffixLength : 0,
			});
			if (guarded.withheld.length > 0) {
				effective = guarded.messages;
				withheldCount = guarded.withheld.length;
				this.pendingNotices.push(overflowNoticeText(guarded, limit));
				await this.log({
					event: "overflow-guard",
					withheld: guarded.withheld.map((record) => ({ id: record.toolCallId, tokens: record.tokens, file: record.file })),
				});
			}
		}

		// Continuity sits after the editable context, outside the mirror.
		const continuity = continuityText(effective);
		const continuityTokens = continuity ? this.calibrator.apply(this.textTokens(continuity)) : 0;
		if (this.continuitySize.observe(continuity ? this.textTokens(continuity) : 0)) {
			this.pendingNotices.push(continuitySizeNoticeText(this.textTokens(continuity ?? "")));
		}

		const snapshot = renderContextDocument(effective, {
			revision: this.state.revision,
			protectedIndexes: new Set<number>(),
			// Constant until the next accepted edit or reset, so header ids read on one call
			// remain valid on the next; bodies are escaped accordingly.
			documentSeed: `${this.sessionID}:${this.nonce}:${checkpoint?.sourceDigest ?? "raw"}`,
		});
		try {
			await this.store.write(snapshot.text);
			this.lastSnapshot = snapshot;
			this.baseline = {
				rawMessages: source,
				effectiveMessages: effective,
				snapshot,
				// The fit gate measures the editable context alone; the system prompt, tool
				// schemas, pinned task and continuity message take their share of budget − reserve first.
				limit: limit === undefined ? undefined : Math.max(1, limit - scopeTokens - pinnedTokens - continuityTokens),
			};
		} catch (error) {
			this.baseline = undefined;
			this.pendingNotices.push(`[CLM] Could not refresh the mirror: ${describe(error)}`);
		}

		const conversationTokens = pinnedTokens + this.estimate(effective) + continuityTokens;
		const requestTokens = scopeTokens + conversationTokens;
		let reading: BudgetReading | undefined;
		if (resolved) {
			reading = {
				...resolved,
				estimated: requestTokens + this.calibrator.apply(this.noticeTokens(this.pendingNotices)),
				...(excluded.length > 0 ? { estimateExcludes: excluded.join(" and ") } : {}),
				calibration: this.calibrator.factor,
				observed: observed?.tokens,
				// The measured request was answered inside the prefix the active revision replaced.
				observedStale: observed !== undefined && checkpoint !== undefined && checkpoint.sourceIds.includes(observed.messageID),
			};
			const tier = this.tracker.observe(reading, budgetTiers(this.settings.budget, resolved.budget, resolved.reserve));
			if (tier) {
				// With the guard off nothing is withheld, so the notice must not describe it.
				this.pendingNotices.push(budgetNoticeText(reading, tier, this.mirrorPath, this.settings.guard === "off" ? null : limit));
				await this.log({ event: "budget-notice", tier: tier.label, estimated: reading.estimated });
			}
			this.lastReading = reading;
		}

		const notices = this.pendingNotices;
		this.pendingNotices = [];
		const messages = [
			...pinnedMessages,
			...unflatten(effective, context),
			...(continuity ? [noteMessage(continuity, "continuity", context)] : []),
			...(notices.length > 0 ? [noteMessage(notices.join("\n\n"), `notice:${this.requests}`, context)] : []),
		];

		// Calibrate only against a same-scope estimate: the provider count includes the system
		// prompt and tool schemas, so both sizes must be known.
		if (systemTokens !== undefined && toolTokens !== undefined) {
			const conversation = this.rawTokens(flatten(pinnedMessages)) + this.rawTokens(effective) +
				(continuity ? this.textTokens(continuity) : 0) + this.noticeTokens(notices);
			this.calibrator.record(systemTokens + toolTokens + conversation, raw.length);
		}

		this.lastRequest = { rawMessages: raw.length, sentMessages: messages.length, mirrorBlocks: snapshot.blocks.length };
		if (this.settings.dumpRequests) {
			const directory = join(this.store.directory, "requests");
			await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => undefined);
			await writeFile(join(directory, `n${this.requests}.json`), JSON.stringify(messages, null, 1), { mode: 0o600 }).catch(() => undefined);
		}
		await this.log({
			event: "request",
			n: this.requests,
			revision: this.state.revision,
			raw: raw.length,
			sent: messages.length,
			blocks: snapshot.blocks.length,
			withheld: withheldCount,
			estimated: reading?.estimated ?? requestTokens,
			observedPrevious: observed?.tokens,
			calibration: this.calibrator.factor,
			notices: notices.map((notice) => notice.slice(0, 80)),
		});
		return { messages, notices, estimated: reading?.estimated ?? requestTokens, reading };
	}

	/** Inputs for presentation.ts `statusText` / `statusLine`. */
	status(steering?: SteeringDocument): ClmStatus {
		const checkpoint = this.state.checkpoint;
		return {
			sessionID: this.sessionID,
			mirrorPath: this.mirrorPath,
			revision: this.state.revision,
			accepted: this.accepted,
			rejected: this.rejected,
			gate: this.settings.gate,
			guard: this.settings.guard,
			reading: this.lastReading,
			modelWindow: this.limits.context,
			checkpoint: checkpoint
				? {
					revision: checkpoint.revision,
					anchorCount: checkpoint.sourceMessageCount,
					beforeEstimate: checkpoint.beforeEstimate,
					afterEstimate: checkpoint.afterEstimate,
				}
				: undefined,
			lastRequest: this.lastRequest,
			steering,
		};
	}
}
