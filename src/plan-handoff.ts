import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, getAgentDir, serializeConversation } from "@earendil-works/pi-coding-agent";
import { type PickableModel, selectModel } from "./model-picker-ui";

type ModelRegistry = ExtensionCommandContext["modelRegistry"];
type CompletionContext = Parameters<ModelRegistry["complete"]>[1];

const SYNTHESIS_SYSTEM_PROMPT = `
You are writing a standalone implementation plan document that will be handed to a fresh agent session with NO access to this conversation.

Read the ENTIRE conversation, not just the final plan proposal. Earlier turns usually carry information the final proposal assumes but never restates: the user's actual goal and constraints, clarifications and corrections they gave, approaches that were considered and rejected (and why), concrete file paths, symbols and line references discovered while investigating, external documentation findings, and validation steps that surfaced along the way. All of it must survive into the document.

Write the document so that someone who has never seen the conversation can execute it correctly. Prefer concrete file paths and symbol names over vague references. Do not refer to "the plan above", "as discussed", or "the previous message".

Respond in EXACTLY this format, with no preamble and no code fence around the whole response:

TITLE: <short kebab-case slug, max 6 words, describing the task>
SUMMARY: <one sentence describing the task, written as an instruction>
---
<the full markdown plan document>
`.trim();

/**
 * Starting a new session tears down the extension instance and re-invokes the
 * factory with a fresh `pi`; the captured one is poisoned. The module itself is
 * cached across that boundary, so the chosen model is parked here and applied by
 * the next instance from its session_start handler.
 */
let pendingHandoffModel: PickableModel | undefined;

const FALLBACK_TITLE = "plan";
const FALLBACK_SUMMARY = "Implement the previously agreed plan.";

export interface PlanDocument {
	title: string;
	summary: string;
	body: string;
}

export function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug.length > 0 ? slug : FALLBACK_TITLE;
}

export function formatPlanFilename(timestamp: Date, title: string): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const date = `${timestamp.getFullYear()}${pad(timestamp.getMonth() + 1)}${pad(timestamp.getDate())}`;
	const time = `${pad(timestamp.getHours())}${pad(timestamp.getMinutes())}${pad(timestamp.getSeconds())}`;
	return `${date}-${time}-${slugify(title)}.md`;
}

/**
 * The model is asked for a TITLE/SUMMARY header so the filename and handoff
 * prompt can be derived without a second call, but the document itself is
 * still usable if the model ignores the contract.
 */
export function parsePlanDocument(response: string, fallbackSummary: string): PlanDocument {
	const match = response.match(
		/^\s*TITLE:\s*(.+?)\s*\n+SUMMARY:\s*(.+?)\s*\n+-{3,}\s*\n([\s\S]*)$/,
	);

	if (match) {
		const [, title, summary, body] = match;
		return { title: slugify(title), summary: summary.trim(), body: body.trim() };
	}

	const body = response.trim();
	const firstHeading = body.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
	const summary = firstHeading ?? fallbackSummary;
	return { title: slugify(summary), summary, body };
}

function getBranchMessages(ctx: ExtensionCommandContext) {
	return ctx.sessionManager
		.getBranch()
		.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message")
		.map((entry) => entry.message);
}

function getConversationTranscript(ctx: ExtensionCommandContext): string {
	return serializeConversation(convertToLlm(getBranchMessages(ctx)));
}

/** Used as the handoff summary when the model ignores the response contract. */
function getFirstUserRequest(ctx: ExtensionCommandContext): string {
	for (const message of convertToLlm(getBranchMessages(ctx))) {
		if (message.role !== "user") {
			continue;
		}
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join(" ");
		const normalized = text.replace(/\s+/g, " ").trim();
		if (normalized.length > 0) {
			return normalized.length > 200 ? `${normalized.slice(0, 197)}...` : normalized;
		}
	}
	return FALLBACK_SUMMARY;
}

async function synthesizePlanDocument(
	ctx: ExtensionCommandContext,
	model: PickableModel,
	fallbackSummary: string,
): Promise<PlanDocument | undefined> {
	const transcript = getConversationTranscript(ctx);

	const response = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Writing plan document…", {
			cancellable: true,
		});
		loader.onAbort = () => done(undefined);

		const completionContext: CompletionContext = {
			systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: `## Conversation\n\n${transcript}` }],
					timestamp: Date.now(),
				},
			],
		};

		ctx.modelRegistry
			.complete(model, completionContext, { signal: loader.signal })
			.then((message) => {
				if (message.stopReason === "aborted") {
					done(undefined);
					return;
				}
				done(
					message.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join("\n"),
				);
			})
			.catch(() => done(undefined));

		return loader;
	});

	if (response === undefined || response.trim().length === 0) {
		return undefined;
	}

	return parsePlanDocument(response, fallbackSummary);
}

function writePlanDocument(document: PlanDocument): string {
	// getAgentDir() resolves PI_CODING_AGENT_DIR (with ~ expansion), defaulting to ~/.pi/agent.
	const plansDir = join(getAgentDir(), "plans");
	mkdirSync(plansDir, { recursive: true });

	const filePath = join(plansDir, formatPlanFilename(new Date(), document.title));
	writeFileSync(filePath, `${document.body}\n`, "utf-8");
	return filePath;
}

export interface PlanHandoffOptions {
	pi: ExtensionAPI;
	notify: (ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error") => void;
	/** Restores the normal tool set and clears plan-mode state. */
	leavePlanMode: (ctx: ExtensionCommandContext) => void;
}

export function createPlanHandoff({ pi, notify, leavePlanMode }: PlanHandoffOptions) {
	async function runPlanHandoff(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			notify(ctx, "Plan handoff requires interactive mode.", "error");
			return;
		}

		const planningModel = ctx.model;
		if (!planningModel) {
			notify(ctx, "No model selected.", "error");
			return;
		}

		await ctx.waitForIdle();

		const document = await synthesizePlanDocument(ctx, planningModel, getFirstUserRequest(ctx));
		if (!document) {
			notify(ctx, "Plan handoff cancelled. Nothing was saved.", "info");
			return;
		}

		let filePath: string;
		try {
			filePath = writePlanDocument(document);
		} catch (error) {
			notify(ctx, `Failed to save plan: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		notify(ctx, `Saved plan to ${filePath}`);

		const model = await selectModel(ctx.ui, ctx);
		if (!model) {
			// Cancelling the picker aborts the handoff entirely: the plan file stays
			// on disk, but plan mode and the conversation are left untouched.
			notify(ctx, `Model selection cancelled. Plan saved to ${filePath}.`, "info");
			return;
		}

		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			notify(ctx, `No credentials configured for ${model.provider}/${model.id}.`, "error");
			return;
		}

		leavePlanMode(ctx);

		pendingHandoffModel = model;

		const handoffPrompt = `${document.summary}\n\nImplement the plan described in ${filePath}`;
		const result = await ctx.newSession({
			parentSession: ctx.sessionManager.getSessionFile(),
			// Only the replacement context may touch the new session; the captured
			// pi/ctx are bound to the session that just went away.
			withSession: async (sessionCtx) => {
				sessionCtx.ui.setEditorText(handoffPrompt);
			},
		});

		if (result.cancelled) {
			pendingHandoffModel = undefined;
			notify(ctx, `New session cancelled. Plan saved to ${filePath}.`, "warning");
		}
	}

	/** Call from session_start of the instance that replaced the planning session. */
	async function applyPendingModel(ctx: ExtensionContext): Promise<void> {
		const model = pendingHandoffModel;
		pendingHandoffModel = undefined;
		if (!model) {
			return;
		}
		if (!(await pi.setModel(model))) {
			notify(ctx, `Could not switch to ${model.provider}/${model.id}.`, "error");
		}
	}

	return { runPlanHandoff, applyPendingModel };
}
