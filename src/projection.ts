// Adapted from pi-clm src/projection.ts (MIT, Copyright 2026 Emanuel Casco).
//
// A checkpoint records one accepted mirror edit: the flattened raw prefix it replaces
// (count + SHA-256 digest) and the projected messages that stand in for that prefix.
// Messages are the flat form `opencode.ts` produces from OpenCode's `{ info, parts }`
// history. `digestSourcePrefix` hashes a key-sorted JSON serialization, so a checkpoint saved
// by one process validates against the same history flattened by another.
//
// The anchor is prune-invariant. OpenCode's `compaction.prune` (opt-in) clears old tool
// outputs in place (`state.time.compacted`), exactly in the old prefix a checkpoint covers.
// The source digest therefore hashes each `toolResult` without its content, and the
// checkpoint also stores the `ocMessageID` of every flat source message. Revert removes
// whole messages (ids change) or truncates the parts of a kept message (its toolCall and
// toolResult disappear, so the digest changes); both still fail closed.
//
// pi-clm's `recoverProjectionFromRetryErrors` is not ported. Pi writes failed assistant
// responses to its session log but drops them from live state, so a resumed log hashes
// differently. OpenCode keeps the error on the assistant message (`info.error`), and the
// flattener drops failed assistant messages before digesting, both when the checkpoint is
// created and when it is applied. The mismatch that recovery repairs cannot occur.
import { digestMessages } from "./context-document.ts";
import type { ContextEditTrace, LiveContextMessage } from "./types.ts";

export const PROJECTION_PREFIX_MISMATCH_REASON =
	"Raw context prefix no longer matches the projection checkpoint.";
export const PROJECTION_SOURCE_IDS_REASON =
	"Raw context prefix message ids no longer match the projection checkpoint (revert or compaction).";
export const PROJECTION_SHORTER_REASON = "Raw context is shorter than the projection source prefix.";

export type EstimateUnit = "characters" | "tokens";

export interface ProjectionCheckpoint {
	version: 1;
	revision: number;
	/** Number of flattened raw messages the projection replaces. */
	sourceMessageCount: number;
	/** `ocMessageID` of each of those messages ("" when absent); length is sourceMessageCount. */
	sourceIds: string[];
	/** `digestSourcePrefix` of those messages. */
	sourceDigest: string;
	projectedMessages: LiveContextMessage[];
	beforeEstimate: number;
	afterEstimate: number;
	estimateUnit: EstimateUnit;
	createdAt: string;
	/** Provenance for the accepted edit that produced projectedMessages. */
	editTrace?: ContextEditTrace;
}

export type ProjectionApplication =
	| {
			valid: true;
			messages: LiveContextMessage[];
			suffix: LiveContextMessage[];
	  }
	| {
			valid: false;
			messages: LiveContextMessage[];
			reason: string;
	  };

/** The OpenCode message id a flat message came from, or "" when it has none. */
export function sourceMessageId(message: LiveContextMessage): string {
	return typeof message.ocMessageID === "string" ? message.ocMessageID : "";
}

/**
 * Digest a raw source prefix in a form OpenCode's prune cannot change: every `toolResult`
 * keeps only role, toolCallId, toolName, isError and ocMessageID. Content is dropped for
 * every tool result, not only cleared ones: the output is intact when the checkpoint is
 * created and may be cleared when it is validated.
 */
export function digestSourcePrefix(messages: readonly LiveContextMessage[]): string {
	return digestMessages(
		messages.map((message) => {
			if (message.role !== "toolResult") return message;
			return {
				role: message.role,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				isError: message.isError,
				ocMessageID: message.ocMessageID,
			};
		}),
	);
}

/**
 * `digestSourcePrefix` without OpenCode message ids. `Session.fork` copies every message
 * under a new id, so the copied history digests the same way as the original.
 */
export function digestSourceContent(messages: readonly LiveContextMessage[]): string {
	return digestSourcePrefix(messages.map(({ ocMessageID: _id, ...rest }) => rest as LiveContextMessage));
}

export function createProjectionCheckpoint(options: {
	revision: number;
	sourceMessages: readonly LiveContextMessage[];
	projectedMessages: readonly LiveContextMessage[];
	beforeEstimate: number;
	afterEstimate: number;
	estimateUnit: EstimateUnit;
	createdAt?: string;
	editTrace?: ContextEditTrace;
}): ProjectionCheckpoint {
	const checkpoint: ProjectionCheckpoint = {
		version: 1,
		revision: options.revision,
		sourceMessageCount: options.sourceMessages.length,
		sourceIds: options.sourceMessages.map(sourceMessageId),
		sourceDigest: digestSourcePrefix(options.sourceMessages),
		projectedMessages: [...options.projectedMessages],
		beforeEstimate: options.beforeEstimate,
		afterEstimate: options.afterEstimate,
		estimateUnit: options.estimateUnit,
		createdAt: options.createdAt ?? new Date().toISOString(),
	};
	if (options.editTrace) checkpoint.editTrace = options.editTrace;

	// Fail at creation rather than when state.json is written.
	JSON.stringify(checkpoint);
	return checkpoint;
}

/**
 * Replace the checkpoint's raw source prefix and keep every raw message appended after
 * it. A mismatch fails closed and returns a copy of the untouched raw context.
 */
export function applyProjection(
	rawMessages: readonly LiveContextMessage[],
	checkpoint: ProjectionCheckpoint | undefined,
): ProjectionApplication {
	if (!checkpoint) return { valid: true, messages: [...rawMessages], suffix: [] };
	if (checkpoint.version !== 1) {
		return { valid: false, messages: [...rawMessages], reason: `Unsupported projection version: ${checkpoint.version}.` };
	}
	if (rawMessages.length < checkpoint.sourceMessageCount) {
		return { valid: false, messages: [...rawMessages], reason: PROJECTION_SHORTER_REASON };
	}
	const prefix = rawMessages.slice(0, checkpoint.sourceMessageCount);
	const ids = checkpoint.sourceIds;
	if (
		!Array.isArray(ids) ||
		ids.length !== prefix.length ||
		prefix.some((message, index) => sourceMessageId(message) !== ids[index])
	) {
		return { valid: false, messages: [...rawMessages], reason: PROJECTION_SOURCE_IDS_REASON };
	}
	if (digestSourcePrefix(prefix) !== checkpoint.sourceDigest) {
		return { valid: false, messages: [...rawMessages], reason: PROJECTION_PREFIX_MISMATCH_REASON };
	}
	const suffix = rawMessages.slice(checkpoint.sourceMessageCount);
	return { valid: true, messages: [...checkpoint.projectedMessages, ...suffix], suffix };
}
