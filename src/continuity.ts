// Adapted from pi-clm src/continuity.ts and the live_context_annotate / live_context_recall
// tools in pi-clm src/index.ts (MIT, Copyright 2026 Emanuel Casco).
//
// Pi stores annotations as custom session entries and points at the session entry that
// produced a mirror block; recall re-reads that entry. OpenCode gives plugins no session
// store and no entry ids, so here:
// - annotations are appended to `annotations.jsonl` in the session directory (mode 0600,
//   created on first write); the latest valid snapshot per id wins;
// - a source is named by its mirror block id (`3-ab12cd34ef56`), and the annotation keeps a
//   bounded snapshot of the rendered source text with its hashes, so recall and pins work
//   after the block has been edited out of the context.
// Model-facing text is rewritten for this package.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ToolContext, ToolDefinition, tool } from "@opencode-ai/plugin";

import { blockId, digestMessages, renderMessage } from "./context-document.ts";
import type { LiveContextMessage } from "./types.ts";

export const ANNOTATIONS_FILE = "annotations.jsonl";
export const ANNOTATE_TOOL = "clm_annotate";
export const RECALL_TOOL = "clm_recall";
export const MAX_PIN_SOURCE_TOKENS = 8_000;
export const DEFAULT_RECALL_TOKENS = 2_000;
export const MIN_RECALL_TOKENS = 128;
export const MAX_RECALL_TOKENS = 8_000;
/** Room reserved for the recall header, which counts against `maxTokens`. */
export const RECALL_HEADER_TOKENS = 256;
/**
 * Snapshot bound for continuity / archive sources, so a full snapshot plus the recall header
 * fits MAX_RECALL_TOKENS. Pins keep their whole text (at most MAX_PIN_SOURCE_TOKENS); recall
 * of a pin near that bound can cut its tail, but the pin itself carries the full text.
 */
export const MAX_SNAPSHOT_TOKENS = MAX_RECALL_TOKENS - RECALL_HEADER_TOKENS;
export const CONTINUITY_SIZE_WARNING_TOKENS = 8_000;
export const MAX_LISTED_ANNOTATIONS = 50;
export const TITLE_MAX = 120;
export const TEXT_MAX = 400;

export type LiveContextRetention = "pin" | "continuity" | "archive";

export interface AnnotationSource {
	sessionId: string;
	/** Mirror block id at creation, e.g. `3-ab12cd34ef56`. */
	blockId: string;
	/** Projection revision the block belonged to. */
	revision: number;
	role: string;
	/** Digest of the source message (`digestMessages([message])`): detects a pin already in context. */
	contentHash: string;
	/** sha256 of `text`: detects a damaged snapshot. */
	textHash: string;
	/** Rendered source text, or its head when `truncated`. */
	text: string;
	/** Estimated tokens of the full rendered source. */
	tokens: number;
	truncated: boolean;
}

/**
 * A full append-only annotation snapshot. Resolving appends a new snapshot with the same id
 * rather than rewriting the earlier line.
 */
export interface LiveContextAnnotation {
	version: 1;
	id: string;
	source: AnnotationSource;
	title: string;
	reason: string;
	futureAction: string;
	retention: LiveContextRetention;
	createdAt: string;
	resolvedAt?: string;
	resolution?: string;
}

export interface RecallFormatResult {
	text: string;
	truncated: boolean;
	totalTokens: number;
	returnedTokens: number;
}

export type TokenEstimator = (text: string) => number;

/** Rough default: four characters per token. */
export const estimateTextTokens: TokenEstimator = (text) => Math.ceil(text.length / 4);

/** Warn once per aggregate-note threshold crossing; re-arm after it shrinks below. */
export class ContinuitySizeTracker {
	private warned = false;

	constructor(readonly threshold = CONTINUITY_SIZE_WARNING_TOKENS) {}

	reset(): void {
		this.warned = false;
	}

	observe(tokens: number): boolean {
		if (!Number.isFinite(tokens) || tokens < this.threshold) {
			this.warned = false;
			return false;
		}
		if (this.warned) return false;
		this.warned = true;
		return true;
	}
}

const RETENTIONS = new Set<LiveContextRetention>(["pin", "continuity", "archive"]);
const ANNOTATION_ID_RE = /^lc-[a-f0-9]{12}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function sourceContentHash(message: LiveContextMessage): string {
	return digestMessages([message]);
}

function isCount(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0;
}

export function isLiveContextAnnotation(value: unknown): value is LiveContextAnnotation {
	if (!value || typeof value !== "object") return false;
	const annotation = value as Partial<LiveContextAnnotation>;
	const source = annotation.source as Partial<AnnotationSource> | undefined;
	return (
		annotation.version === 1 &&
		typeof annotation.id === "string" &&
		ANNOTATION_ID_RE.test(annotation.id) &&
		Boolean(source) &&
		typeof source === "object" &&
		typeof source.sessionId === "string" &&
		typeof source.blockId === "string" &&
		isCount(source.revision) &&
		typeof source.role === "string" &&
		typeof source.contentHash === "string" &&
		HASH_RE.test(source.contentHash) &&
		typeof source.textHash === "string" &&
		HASH_RE.test(source.textHash) &&
		typeof source.text === "string" &&
		isCount(source.tokens) &&
		typeof source.truncated === "boolean" &&
		typeof annotation.title === "string" &&
		typeof annotation.reason === "string" &&
		typeof annotation.futureAction === "string" &&
		typeof annotation.retention === "string" &&
		RETENTIONS.has(annotation.retention as LiveContextRetention) &&
		typeof annotation.createdAt === "string" &&
		(annotation.resolvedAt === undefined || typeof annotation.resolvedAt === "string") &&
		(annotation.resolution === undefined || typeof annotation.resolution === "string")
	);
}

/** Latest valid snapshot for each id wins; order is first appearance. */
export function reconstructAnnotations(values: Iterable<unknown>): LiveContextAnnotation[] {
	const latest = new Map<string, LiveContextAnnotation>();
	for (const value of values) {
		if (isLiveContextAnnotation(value)) latest.set(value.id, value);
	}
	return [...latest.values()];
}

export function activeContinuityAnnotations(
	annotations: LiveContextAnnotation[],
): LiveContextAnnotation[] {
	return annotations.filter(
		(annotation) => annotation.resolvedAt === undefined && annotation.retention !== "archive",
	);
}

/** Longest head of `text` whose estimate fits `maxTokens` (binary search; estimator assumed monotonic). */
function headWithin(text: string, maxTokens: number, estimate: TokenEstimator, suffix = ""): string {
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (estimate(`${text.slice(0, middle)}${suffix}`) <= maxTokens) low = middle;
		else high = middle - 1;
	}
	// Defensive step-down for estimators that are not perfectly monotonic.
	while (low > 0 && estimate(`${text.slice(0, low)}${suffix}`) > maxTokens) {
		low = Math.max(0, low - Math.max(1, Math.ceil(low / 20)));
	}
	return text.slice(0, low);
}

/**
 * Snapshot a source message. A pin larger than MAX_PIN_SOURCE_TOKENS is refused and a pin
 * is never truncated; other retentions keep the head that fits MAX_SNAPSHOT_TOKENS.
 */
export function snapshotSource(options: {
	sessionId: string;
	blockId: string;
	revision: number;
	message: LiveContextMessage;
	retention: LiveContextRetention;
	estimateTokens?: TokenEstimator;
}): AnnotationSource {
	const estimate = options.estimateTokens ?? estimateTextTokens;
	const full = renderMessage(options.message);
	const tokens = estimate(full);
	if (options.retention === "pin" && tokens > MAX_PIN_SOURCE_TOKENS) {
		throw new Error(
			`Block ${options.blockId} is about ${tokens} tokens; a pin holds at most ${MAX_PIN_SOURCE_TOKENS}. Use continuity or archive.`,
		);
	}
	const truncated = options.retention !== "pin" && tokens > MAX_SNAPSHOT_TOKENS;
	const text = truncated ? headWithin(full, MAX_SNAPSHOT_TOKENS, estimate) : full;
	return {
		sessionId: options.sessionId,
		blockId: options.blockId,
		revision: options.revision,
		role: options.message.role,
		contentHash: sourceContentHash(options.message),
		textHash: sha256(text),
		text,
		tokens,
		truncated,
	};
}

export function createAnnotation(options: {
	existingIds: Iterable<string>;
	source: AnnotationSource;
	title: string;
	reason: string;
	futureAction: string;
	retention: LiveContextRetention;
	createdAt?: string;
}): LiveContextAnnotation {
	const existingIds = new Set(options.existingIds);
	let id: string;
	do id = `lc-${randomBytes(6).toString("hex")}`;
	while (existingIds.has(id));
	return {
		version: 1,
		id,
		source: { ...options.source },
		title: options.title,
		reason: options.reason,
		futureAction: options.futureAction,
		retention: options.retention,
		createdAt: options.createdAt ?? new Date().toISOString(),
	};
}

export function resolveAnnotation(
	annotation: LiveContextAnnotation,
	resolution: string | undefined,
	resolvedAt = new Date().toISOString(),
): LiveContextAnnotation {
	const resolved: LiveContextAnnotation = {
		...annotation,
		source: { ...annotation.source },
		resolvedAt,
	};
	if (resolution) resolved.resolution = resolution;
	return resolved;
}

/** Throws when the stored snapshot no longer matches its hash. */
export function validateSnapshot(annotation: LiveContextAnnotation): string {
	if (sha256(annotation.source.text) !== annotation.source.textHash) {
		throw new Error(`The stored source of ${annotation.id} failed its hash check.`);
	}
	return annotation.source.text;
}

const PIN_CLOSE_RE = /<\/(clm-pinned-source)/gi;

/** Neutralise closing tags inside pinned text so it cannot end its own wrapper. */
export function escapePinnedText(text: string): string {
	return text.replace(PIN_CLOSE_RE, "<\\/$1");
}

function compactLine(value: string, maxLength: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * The plugin-managed message appended after the projected conversation on every request:
 * one entry per active pin / continuity annotation, plus the exact text of each pin whose
 * source is no longer in the projected conversation. Undefined when nothing is active.
 */
export function formatContinuityMessage(options: {
	annotations: LiveContextAnnotation[];
	effectiveMessages: LiveContextMessage[];
}): string | undefined {
	const active = activeContinuityAnnotations(options.annotations);
	if (active.length === 0) return undefined;
	const effectiveHashes = active.some((annotation) => annotation.retention === "pin")
		? new Set(options.effectiveMessages.map(sourceContentHash))
		: new Set<string>();
	const sections = [
		"[CLM CONTINUITY: kept by the plugin outside the context mirror; editing the mirror does not change it]",
	];
	for (const annotation of active) {
		sections.push(
			`- [${annotation.id}] ${annotation.retention}: ${compactLine(annotation.title, TITLE_MAX)}`,
			`  Why: ${compactLine(annotation.reason, 240)}`,
			`  Next: ${compactLine(annotation.futureAction, 240)}`,
			`  Source: block ${annotation.source.blockId} (${annotation.source.role}) · full text via ${RECALL_TOOL}({ id: "${annotation.id}" })`,
		);
		if (annotation.retention !== "pin") continue;
		if (effectiveHashes.has(annotation.source.contentHash)) {
			sections.push("  The pinned source is still in the conversation above.");
			continue;
		}
		try {
			const text = validateSnapshot(annotation);
			sections.push(
				`  Pinned source text (${annotation.source.role}):`,
				"  <clm-pinned-source>",
				escapePinnedText(text),
				"  </clm-pinned-source>",
			);
		} catch (error) {
			sections.push(`  Pin unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return sections.join("\n");
}

export function continuitySizeNoticeText(
	tokens: number,
	threshold = CONTINUITY_SIZE_WARNING_TOKENS,
): string {
	return (
		`[CLM] Active pin and continuity annotations add about ${tokens} estimated tokens to every request` +
		` (warning at ${threshold}), and editing the mirror cannot shrink them.` +
		` Resolve finished annotations with ${ANNOTATE_TOOL}, and use archive for sources you only need to recall.`
	);
}

export function clampRecallTokens(maxTokens: number | undefined): number {
	const requested =
		maxTokens !== undefined && Number.isFinite(maxTokens) ? Math.floor(maxTokens) : DEFAULT_RECALL_TOKENS;
	return Math.max(MIN_RECALL_TOKENS, Math.min(MAX_RECALL_TOKENS, requested));
}

export function formatRecall(options: {
	annotation: LiveContextAnnotation;
	maxTokens?: number;
	estimateTokens?: TokenEstimator;
}): RecallFormatResult {
	const { annotation } = options;
	const estimate = options.estimateTokens ?? estimateTextTokens;
	const maxTokens = clampRecallTokens(options.maxTokens);
	const body = validateSnapshot(annotation);
	const header = [
		`[clm recall ${annotation.id}]`,
		`source: session ${annotation.source.sessionId} · block ${annotation.source.blockId} · revision ${annotation.source.revision}`,
		`hash: ${annotation.source.contentHash}`,
		`retention: ${annotation.retention}${annotation.resolvedAt ? ` · resolved ${annotation.resolvedAt}` : ""}`,
		`title: ${compactLine(annotation.title, TITLE_MAX)}`,
		...(annotation.source.truncated
			? [`stored: the first part of a ${annotation.source.tokens}-token source; the rest was not kept`]
			: []),
		"",
		`--- source text (${annotation.source.role}) ---`,
	].join("\n");
	const full = `${header}\n${body}`;
	const totalTokens = estimate(full);
	if (totalTokens <= maxTokens) {
		return { text: full, truncated: false, totalTokens, returnedTokens: totalTokens };
	}

	const marker = "\n\n[source truncated to maxTokens; ask for a larger maxTokens to see more]";
	const head = headWithin(body, maxTokens, (candidate) => estimate(`${header}\n${candidate}`), marker);
	let text = `${header}\n${head}${marker}`;
	if (estimate(text) > maxTokens) {
		const fallbackMarker = "\n[recall truncated]";
		const fallback = headWithin(full, maxTokens, estimate, fallbackMarker);
		text = `${fallback}${fallbackMarker}`;
		if (estimate(text) > maxTokens) text = "";
	}
	return { text, truncated: true, totalTokens, returnedTokens: estimate(text) };
}

export interface AnnotationStoreOptions {
	estimateTokens?: TokenEstimator;
	now?: () => Date;
}

export interface LoadedAnnotations {
	annotations: LiveContextAnnotation[];
	/** Lines that were not valid annotation JSON (e.g. a torn last line); ignored. */
	skipped: number;
}

export interface CreateAnnotationInput {
	sessionId: string;
	blockId: string;
	revision: number;
	message: LiveContextMessage;
	title: string;
	reason: string;
	futureAction: string;
	retention: LiveContextRetention;
}

/**
 * Create / resolve tails per resolved `annotations.jsonl` path, shared by every store
 * instance in this process, so a caller may build a new store per tool call.
 */
const fileQueues = new Map<string, Promise<unknown>>();

/**
 * The origin's annotations as a fork of it carries them (pi: a branch carries the annotation
 * entries on its path). OpenCode's `Session.fork` copies messages with new ids
 * (session/session.ts:691-730) and keeps their times, and an annotation's `contentHash` and
 * block id digest the source message with its id. So:
 * - an annotation created after `cutoff` (ms; the fork's newest copied message) belongs to
 *   the origin's later history and is left out; one resolved after it is carried unresolved;
 * - a source found in the fork's `messages` by its rendered text (role and text, or the head
 *   of a truncated snapshot) is re-pointed at the fork's copy: hash, block id (its position
 *   in `messages`) and session; an unmatched source keeps the origin's values and
 *   stays recallable from its stored text. Identical messages (a repeated prompt, the same
 *   tool output twice) map to the first copy: same text and hash, possibly another block id.
 *   Block ids index `messages` as the caller passes them (the effective messages before the
 *   overflow guard, which replaces results in place and so keeps positions).
 * Ids, titles, text, creation times and `source.revision` (the origin's revision) are kept.
 */
export function forkAnnotations(
	annotations: readonly LiveContextAnnotation[],
	messages: readonly LiveContextMessage[],
	options: { sessionId: string; cutoff?: number },
): LiveContextAnnotation[] {
	const rendered = messages.map((message) => renderMessage(message));
	const before = (iso: string | undefined) => iso !== undefined && (options.cutoff === undefined || Date.parse(iso) <= options.cutoff);
	const out: LiveContextAnnotation[] = [];
	for (const annotation of annotations) {
		if (!before(annotation.createdAt)) continue;
		const copy: LiveContextAnnotation = { ...annotation, source: { ...annotation.source } };
		if (copy.resolvedAt !== undefined && !before(copy.resolvedAt)) {
			delete copy.resolvedAt;
			delete copy.resolution;
		}
		const { source } = copy;
		const index = messages.findIndex((message, position) =>
			message.role === source.role &&
			(source.truncated ? rendered[position]!.startsWith(source.text) : rendered[position] === source.text));
		if (index >= 0) {
			copy.source = { ...source, sessionId: options.sessionId, contentHash: sourceContentHash(messages[index]!), blockId: blockId(messages[index]!, index) };
		}
		out.push(copy);
	}
	return out;
}

/** Bound on the annotations a session without a mirror keeps in OpenCode's session metadata, bytes of JSON. */
export const PERSISTED_ANNOTATIONS_BYTES = 64 * 1024;

/**
 * Annotations of a session without a mirror, as kept in OpenCode's session metadata
 * (`metadata.clm.annotations`) so they survive a restart; the session's files then live in a
 * per-process temp directory. `resolved` records every resolution (small); `annotations`
 * holds full snapshots, active ones first, as many as fit the byte bound.
 */
export interface PersistedAnnotations {
	version: 1;
	resolved: Array<{ id: string; resolvedAt: string; resolution?: string }>;
	annotations: LiveContextAnnotation[];
}

/** The record for `metadata.clm.annotations`, at most `maxBytes` of JSON. */
export function persistAnnotations(annotations: readonly LiveContextAnnotation[], maxBytes = PERSISTED_ANNOTATIONS_BYTES): PersistedAnnotations {
	const out: PersistedAnnotations = { version: 1, resolved: [], annotations: [] };
	let size = Buffer.byteLength(JSON.stringify(out));
	const fits = (value: unknown) => {
		const added = Buffer.byteLength(JSON.stringify(value)) + 1;
		if (size + added > maxBytes) return false;
		size += added;
		return true;
	};
	for (const annotation of annotations) {
		if (annotation.resolvedAt === undefined) continue;
		const stub = { id: annotation.id, resolvedAt: annotation.resolvedAt, ...(annotation.resolution !== undefined ? { resolution: annotation.resolution } : {}) };
		if (fits(stub)) out.resolved.push(stub);
	}
	const rank = (annotation: LiveContextAnnotation) => (annotation.resolvedAt === undefined && annotation.retention !== "archive" ? 0 : 1);
	for (const annotation of [...annotations].sort((left, right) => rank(left) - rank(right))) {
		if (fits(annotation)) out.annotations.push(annotation);
	}
	return out;
}

/**
 * Snapshots to append to a store holding `current` so it reflects `persisted` (a
 * `PersistedAnnotations` read back from metadata; anything else yields nothing): annotations
 * the store lacks, then resolutions of ones it holds unresolved.
 */
export function restorePersisted(current: readonly LiveContextAnnotation[], persisted: unknown): LiveContextAnnotation[] {
	if (!persisted || typeof persisted !== "object") return [];
	const record = persisted as Partial<PersistedAnnotations>;
	if (record.version !== 1) return [];
	const byId = new Map(current.map((annotation) => [annotation.id, annotation]));
	const out: LiveContextAnnotation[] = [];
	for (const annotation of Array.isArray(record.annotations) ? record.annotations : []) {
		if (!isLiveContextAnnotation(annotation) || byId.has(annotation.id)) continue;
		byId.set(annotation.id, annotation);
		out.push(annotation);
	}
	for (const stub of Array.isArray(record.resolved) ? record.resolved : []) {
		if (!stub || typeof stub !== "object" || typeof stub.id !== "string" || typeof stub.resolvedAt !== "string") continue;
		const annotation = byId.get(stub.id);
		if (!annotation || annotation.resolvedAt !== undefined) continue;
		const resolved = resolveAnnotation(annotation, typeof stub.resolution === "string" ? stub.resolution : undefined, stub.resolvedAt);
		byId.set(stub.id, resolved);
		out.push(resolved);
	}
	return out;
}

/** Append-only `annotations.jsonl` in one session directory. */
export class AnnotationStore {
	readonly filePath: string;
	private readonly estimate: TokenEstimator;
	private readonly now: () => Date;

	constructor(
		readonly directory: string,
		options: AnnotationStoreOptions = {},
	) {
		this.filePath = resolve(directory, ANNOTATIONS_FILE);
		this.estimate = options.estimateTokens ?? estimateTextTokens;
		this.now = options.now ?? (() => new Date());
	}

	async load(): Promise<LoadedAnnotations> {
		let text: string;
		try {
			text = await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { annotations: [], skipped: 0 };
			throw error;
		}
		const values: unknown[] = [];
		let skipped = 0;
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const value: unknown = JSON.parse(line);
				if (isLiveContextAnnotation(value)) values.push(value);
				else skipped++;
			} catch {
				skipped++;
			}
		}
		return { annotations: reconstructAnnotations(values), skipped };
	}

	async list(): Promise<LiveContextAnnotation[]> {
		return (await this.load()).annotations;
	}

	async active(): Promise<LiveContextAnnotation[]> {
		return activeContinuityAnnotations(await this.list());
	}

	async get(id: string): Promise<LiveContextAnnotation> {
		const annotation = (await this.list()).find((candidate) => candidate.id === id);
		if (!annotation) throw new Error(`Annotation ${id} does not exist in this session.`);
		return annotation;
	}

	create(input: CreateAnnotationInput): Promise<LiveContextAnnotation> {
		return this.serialize(async () => {
			const source = snapshotSource({ ...input, estimateTokens: this.estimate });
			const annotation = createAnnotation({
				existingIds: (await this.list()).map((candidate) => candidate.id),
				source,
				title: input.title,
				reason: input.reason,
				futureAction: input.futureAction,
				retention: input.retention,
				createdAt: this.now().toISOString(),
			});
			await this.append(annotation);
			return annotation;
		});
	}

	resolve(id: string, resolution?: string): Promise<LiveContextAnnotation> {
		return this.serialize(async () => {
			const existing = await this.get(id);
			if (existing.resolvedAt) throw new Error(`Annotation ${id} is already resolved.`);
			const resolved = resolveAnnotation(existing, resolution, this.now().toISOString());
			await this.append(resolved);
			return resolved;
		});
	}

	/** Appends snapshots as they are (`restorePersisted`); the latest per id wins on load. */
	appendAll(annotations: readonly LiveContextAnnotation[]): Promise<void> {
		return this.serialize(async () => {
			for (const annotation of annotations) await this.append(annotation);
		});
	}

	/**
	 * Writes another session's annotations into this store as they are (`forkAnnotations`),
	 * only while this store holds none; returns how many were written.
	 */
	importAll(annotations: readonly LiveContextAnnotation[]): Promise<number> {
		return this.serialize(async () => {
			if (annotations.length === 0 || (await this.list()).length > 0) return 0;
			for (const annotation of annotations) await this.append(annotation);
			return annotations.length;
		});
	}

	async recall(
		id: string,
		maxTokens?: number,
	): Promise<RecallFormatResult & { annotation: LiveContextAnnotation }> {
		const annotation = await this.get(id);
		return { annotation, ...formatRecall({ annotation, maxTokens, estimateTokens: this.estimate }) };
	}

	/**
	 * One write per record, framed `\n<json>\n`: a torn earlier append then ends at the
	 * leading newline instead of swallowing this record. `load()` skips the blank lines.
	 * O_NOFOLLOW refuses a symlink planted at the file path.
	 */
	private async append(annotation: LiveContextAnnotation): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const handle = await open(
			this.filePath,
			constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await handle.write(`\n${JSON.stringify(annotation)}\n`);
		} finally {
			await handle.close();
		}
	}

	/** Create and resolve read, then append: run them one at a time per file. */
	private serialize<T>(task: () => Promise<T>): Promise<T> {
		const key = this.filePath;
		const run = (fileQueues.get(key) ?? Promise.resolve()).then(task, task);
		const tail = run.catch(() => undefined);
		fileQueues.set(key, tail);
		void tail.then(() => {
			if (fileQueues.get(key) === tail) fileQueues.delete(key);
		});
		return run;
	}
}

// ---- OpenCode tools ------------------------------------------------------------------

export type ToolSchema = typeof tool.schema;

export const ANNOTATE_DESCRIPTION = [
	"Create, resolve, or list continuity annotations for this session.",
	"create: name a block id from the context mirror (the id= value in a CTX_TURN header, e.g. 3-ab12cd34ef56) and a retention:",
	`- pin: the exact source text stays in every request until resolved (at most ${MAX_PIN_SOURCE_TOKENS} tokens);`,
	"- continuity: every request carries the title, reason and next action, and the source stays recallable;",
	"- archive: nothing is carried; the source is only recallable.",
	"Annotate a block before you remove or shorten it in the mirror when later work depends on its exact text. Pin only text that must stay word-for-word visible; prefer continuity or archive.",
	"resolve: pass the annotation id (and an optional resolution) once the obligation is done, so it stops costing tokens.",
	"list: show the most recent annotations.",
].join("\n");

export const RECALL_DESCRIPTION =
	`Return the stored source text of an annotation by id, checked against its hash. ` +
	`Output is bounded to maxTokens estimated tokens (${MIN_RECALL_TOKENS}-${MAX_RECALL_TOKENS}, default ${DEFAULT_RECALL_TOKENS}); ` +
	"request the smallest bound that serves the task.";

export function annotateArgs(z: ToolSchema) {
	return {
		action: z.enum(["create", "resolve", "list"]),
		source: z.string().optional().describe("create: block id from the context mirror, e.g. 3-ab12cd34ef56"),
		id: z.string().optional().describe("resolve: annotation id, e.g. lc-0123456789ab"),
		title: z.string().min(1).max(TITLE_MAX).optional().describe("create: short label"),
		reason: z.string().min(1).max(TEXT_MAX).optional().describe("create: why the source matters"),
		futureAction: z.string().min(1).max(TEXT_MAX).optional().describe("create: what to do with it later"),
		retention: z.enum(["pin", "continuity", "archive"]).optional().describe("create: pin, continuity or archive"),
		resolution: z.string().min(1).max(TEXT_MAX).optional().describe("resolve: outcome"),
	};
}

export function recallArgs(z: ToolSchema) {
	return {
		id: z.string().describe("Annotation id, e.g. lc-0123456789ab"),
		maxTokens: z
			.number()
			.int()
			.min(MIN_RECALL_TOKENS)
			.max(MAX_RECALL_TOKENS)
			.optional()
			.describe(`Upper bound on returned tokens (default ${DEFAULT_RECALL_TOKENS})`),
	};
}

export interface AnnotateArgs {
	action: "create" | "resolve" | "list";
	source?: string;
	id?: string;
	title?: string;
	reason?: string;
	futureAction?: string;
	retention?: LiveContextRetention;
	resolution?: string;
}

export interface RecallArgs {
	id: string;
	maxTokens?: number;
}

/** A block of the mirror the session last rendered. */
export interface ContinuityBlockSource {
	message: LiveContextMessage;
	revision: number;
}

export interface ContinuityToolOptions {
	/** `tool.schema` from @opencode-ai/plugin (zod). Passed in so this module has no runtime import of the plugin package. */
	schema: ToolSchema;
	store(sessionID: string): AnnotationStore | Promise<AnnotationStore>;
	/** Look up a block id in the session's current mirror. */
	block(
		sessionID: string,
		blockId: string,
	): ContinuityBlockSource | undefined | Promise<ContinuityBlockSource | undefined>;
	/** Called after create / resolve, e.g. to refresh a cached continuity message. */
	onChange?(sessionID: string): void | Promise<void>;
}

function requiredText(value: string | undefined, name: string): string {
	const text = value?.replace(/\s+/g, " ").trim();
	if (!text) throw new Error(`${name} is required.`);
	return text;
}

function optionalText(value: string | undefined): string | undefined {
	return value?.replace(/\s+/g, " ").trim() || undefined;
}

export function formatAnnotationList(annotations: LiveContextAnnotation[]): string {
	if (annotations.length === 0) return "No annotations in this session.";
	const shown = annotations.slice(-MAX_LISTED_ANNOTATIONS);
	const lines = shown.map((annotation) => {
		const status = annotation.resolvedAt ? `resolved ${annotation.resolvedAt}` : "active";
		return `[${annotation.id}] ${annotation.retention} · ${status} · ${annotation.title}\n  block ${annotation.source.blockId} · next: ${annotation.futureAction}`;
	});
	if (annotations.length > shown.length) lines.unshift(`${annotations.length - shown.length} older annotations omitted.`);
	return lines.join("\n");
}

async function executeAnnotate(
	options: ContinuityToolOptions,
	args: AnnotateArgs,
	context: ToolContext,
) {
	const store = await options.store(context.sessionID);
	if (args.action === "list") {
		const annotations = await store.list();
		return {
			title: `${annotations.length} annotations`,
			output: formatAnnotationList(annotations),
			metadata: { total: annotations.length },
		};
	}
	if (args.action === "resolve") {
		const resolved = await store.resolve(requiredText(args.id, "id"), optionalText(args.resolution));
		await options.onChange?.(context.sessionID);
		return {
			title: `Resolved ${resolved.id}`,
			output: `Resolved ${resolved.id}: ${resolved.title}`,
			metadata: { id: resolved.id },
		};
	}
	if (args.action !== "create") throw new Error(`Unknown action ${String(args.action)}.`);
	const blockId = requiredText(args.source, "source");
	const title = requiredText(args.title, "title");
	const reason = requiredText(args.reason, "reason");
	const futureAction = requiredText(args.futureAction, "futureAction");
	const retention = args.retention;
	if (!retention || !RETENTIONS.has(retention)) throw new Error("retention is required: pin, continuity or archive.");
	const block = await options.block(context.sessionID, blockId);
	if (!block) throw new Error(`Block ${blockId} is not in the current context mirror.`);
	const annotation = await store.create({
		sessionId: context.sessionID,
		blockId,
		revision: block.revision,
		message: block.message,
		title,
		reason,
		futureAction,
		retention,
	});
	await options.onChange?.(context.sessionID);
	const note = annotation.source.truncated
		? ` Only the first part of the ${annotation.source.tokens}-token source was kept.`
		: "";
	return {
		title: `Created ${annotation.id}`,
		output: `Created ${retention} annotation ${annotation.id} for ${annotation.source.role} block ${blockId}.${note}`,
		metadata: { id: annotation.id, retention, truncated: annotation.source.truncated },
	};
}

async function executeRecall(options: ContinuityToolOptions, args: RecallArgs, context: ToolContext) {
	const store = await options.store(context.sessionID);
	const recalled = await store.recall(requiredText(args.id, "id"), args.maxTokens);
	return {
		title: `Recall ${recalled.annotation.id}`,
		output: recalled.text,
		metadata: {
			id: recalled.annotation.id,
			truncated: recalled.truncated,
			totalTokens: recalled.totalTokens,
			returnedTokens: recalled.returnedTokens,
		},
	};
}

/**
 * OpenCode tool definitions, keyed by tool name, for the plugin's `tool` hook. `store` may
 * return a new AnnotationStore per call: writes are serialised per file path, not per instance.
 */
export function continuityTools(options: ContinuityToolOptions): Record<string, ToolDefinition> {
	return {
		[ANNOTATE_TOOL]: {
			description: ANNOTATE_DESCRIPTION,
			args: annotateArgs(options.schema),
			execute: (args, context) => executeAnnotate(options, args as unknown as AnnotateArgs, context),
		},
		[RECALL_TOOL]: {
			description: RECALL_DESCRIPTION,
			args: recallArgs(options.schema),
			execute: (args, context) => executeRecall(options, args as unknown as RecallArgs, context),
		},
	};
}
