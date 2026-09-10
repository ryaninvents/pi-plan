import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, Key, matchesKey, SelectList, truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Pi's own ModelSelectorComponent needs a ModelRuntime, which is only reachable
 * through a private field on ctx.modelRegistry, so this renders an equivalent
 * picker from public API surface instead.
 */
export type PickableModel = NonNullable<ExtensionContext["model"]>;

const MAX_VISIBLE_MODELS = 12;

function getModelReference(model: PickableModel): string {
	return `${model.provider}/${model.id}`;
}

function getCandidateModels(ctx: ExtensionContext): PickableModel[] {
	// Session scoping (--models / enabledModels) narrows what the user may pick.
	if (ctx.scopedModels.length > 0) {
		return ctx.scopedModels.map((scoped) => scoped.model);
	}
	return ctx.modelRegistry.getAvailable();
}

export async function selectModel(
	ui: ExtensionUIContext,
	ctx: ExtensionContext,
): Promise<PickableModel | undefined> {
	const candidates = getCandidateModels(ctx);
	if (candidates.length === 0) {
		ui.notify("No models with configured credentials are available.", "error");
		return undefined;
	}

	const currentReference = ctx.model ? getModelReference(ctx.model) : undefined;
	const modelsByReference = new Map(
		candidates.map((model) => [getModelReference(model), model] as const),
	);

	return ui.custom<PickableModel | undefined>((tui, theme, _keybindings, done) => {
		const searchInput = new Input({ prompt: "  ", placeholder: "Filter models…" });
		let filtered = candidates;
		let cachedRenderedLines: string[] | undefined;

		const buildSelectList = (): SelectList =>
			new SelectList(
				filtered.map((model) => {
					const reference = getModelReference(model);
					// The primary column is truncated on narrow terminals, so the
					// current-model marker rides in the description instead.
					return {
						value: reference,
						label: reference,
						description:
							reference === currentReference ? `${model.name} — current` : model.name,
					};
				}),
				MAX_VISIBLE_MODELS,
				{
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				},
			);

		let selectList = buildSelectList();

		const requestUiRerender = () => {
			cachedRenderedLines = undefined;
			tui.requestRender();
		};

		const applyFilter = (query: string) => {
			// SelectList.setFilter only does prefix matching on `value`, which is
			// unusable for provider/id references, so filtering happens here.
			filtered =
				query.trim().length === 0
					? candidates
					: fuzzyFilter(candidates, query, getModelReference);
			selectList = buildSelectList();
			requestUiRerender();
		};

		const submitSelection = () => {
			const selected = selectList.getSelectedItem();
			if (!selected) {
				return;
			}
			done(modelsByReference.get(selected.value));
		};

		const render = (width: number): string[] => {
			if (cachedRenderedLines) {
				return cachedRenderedLines;
			}

			const renderedLines: string[] = [];
			const addLine = (line: string) => renderedLines.push(truncateToWidth(line, width));

			addLine(theme.fg("accent", "─".repeat(width)));
			addLine(theme.fg("text", " Select model for the new session"));
			renderedLines.push("");
			renderedLines.push(...searchInput.render(width));
			renderedLines.push("");
			renderedLines.push(...selectList.render(width));
			renderedLines.push("");
			addLine(theme.fg("dim", " ↑↓ move • Enter select • type to filter • Esc cancel"));
			addLine(theme.fg("accent", "─".repeat(width)));

			cachedRenderedLines = renderedLines;
			return renderedLines;
		};

		const handleInput = (data: string) => {
			if (matchesKey(data, Key.escape)) {
				done(undefined);
				return;
			}

			if (matchesKey(data, Key.enter)) {
				submitSelection();
				return;
			}

			if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
				selectList.handleInput(data);
				requestUiRerender();
				return;
			}

			const previousQuery = searchInput.getValue();
			searchInput.handleInput(data);
			const nextQuery = searchInput.getValue();
			if (nextQuery !== previousQuery) {
				applyFilter(nextQuery);
				return;
			}
			requestUiRerender();
		};

		searchInput.focused = true;

		return {
			render,
			invalidate: () => {
				cachedRenderedLines = undefined;
			},
			handleInput,
		};
	});
}
