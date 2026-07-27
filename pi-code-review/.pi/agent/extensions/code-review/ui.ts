import { BorderedLoader, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

// Minimal structural type for the command context UI we use (avoids importing
// internal types that may shift between versions).
export interface UiLike {
	custom<T>(factory: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any): Promise<T | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface ToggleItem {
	id: string;
	label: string;
	description?: string;
	checked: boolean;
}

/**
 * Checkbox multi-select built on SettingsList.
 * space toggles, enter confirms all selections, esc cancels.
 * Returns the set of checked ids, or null on cancel.
 */
export async function multiToggle(
	ui: UiLike,
	mode: string,
	title: string,
	items: ToggleItem[],
): Promise<Set<string> | null> {
	if (mode !== "tui") return new Set(items.filter((i) => i.checked).map((i) => i.id));

	const checked = new Set(items.filter((i) => i.checked).map((i) => i.id));

	const result = await ui.custom<Set<string> | null>(
		(tui: any, theme: any, _kb: any, done: (v: Set<string> | null) => void) => {
			const settingItems: SettingItem[] = items.map((item) => ({
				id: item.id,
				label: item.description ? `${item.label} — ${item.description}` : item.label,
				currentValue: item.checked ? "✓ include" : "✗ skip",
				values: ["✓ include", "✗ skip"],
			}));

			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			const settingsList = new SettingsList(
				settingItems,
				Math.min(settingItems.length + 2, 15),
				getSettingsListTheme(),
				(id: string, newValue: string) => {
					if (newValue.startsWith("✓")) checked.add(id);
					else checked.delete(id);
				},
				() => done(null), // esc cancels
			);
			container.addChild(settingsList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • space toggle • enter confirm • esc cancel"), 1, 0));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (matchesKey(data, "return")) {
						done(new Set(checked));
						return;
					}
					if (data === " ") {
						// SettingsList toggles values on enter; map space to it
						settingsList.handleInput?.("\r");
						tui.requestRender();
						return;
					}
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		},
	);

	if (result === undefined || result === null) return null;
	return result;
}

export type LoaderResult<T> = { ok: true; value: T } | { ok: false; error?: string; cancelled: boolean };

/**
 * Run an async operation behind a cancellable BorderedLoader.
 * Falls back to running without UI when not in TUI mode.
 */
export async function withLoader<T>(
	ui: UiLike,
	mode: string,
	message: string,
	fn: (signal: AbortSignal) => Promise<T>,
): Promise<LoaderResult<T>> {
	if (mode !== "tui") {
		try {
			return { ok: true, value: await fn(new AbortController().signal) };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error), cancelled: false };
		}
	}

	const result = await ui.custom<LoaderResult<T>>(
		(tui: any, theme: any, _kb: any, done: (v: LoaderResult<T>) => void) => {
			const loader = new BorderedLoader(tui, theme, message);
			loader.onAbort = () => done({ ok: false, cancelled: true });
			fn(loader.signal)
				.then((value) => done({ ok: true, value }))
				.catch((error) =>
					done({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
						cancelled: loader.signal.aborted,
					}),
				);
			return loader;
		},
	);

	return result ?? { ok: false, cancelled: true };
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Like withLoader, but the operation can update the loader message as it moves
 * through phases (e.g. "running reviewers" -> "aggregating findings").
 * esc cancels via the provided AbortSignal.
 */
export async function withPhasedLoader<T>(
	ui: UiLike,
	mode: string,
	initialMessage: string,
	fn: (signal: AbortSignal, setMessage: (message: string) => void) => Promise<T>,
): Promise<LoaderResult<T>> {
	if (mode !== "tui") {
		try {
			return { ok: true, value: await fn(new AbortController().signal, () => {}) };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error), cancelled: false };
		}
	}

	const result = await ui.custom<LoaderResult<T>>(
		(tui: any, theme: any, _kb: any, done: (v: LoaderResult<T>) => void) => {
			const controller = new AbortController();
			let message = initialMessage;
			let frame = 0;
			let finished = false;

			const timer = setInterval(() => {
				frame++;
				tui.requestRender();
			}, 100);

			const finish = (value: LoaderResult<T>) => {
				if (finished) return;
				finished = true;
				clearInterval(timer);
				done(value);
			};

			fn(controller.signal, (m: string) => {
				message = m;
				tui.requestRender();
			})
				.then((value) => finish({ ok: true, value }))
				.catch((error) =>
					finish({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
						cancelled: controller.signal.aborted,
					}),
				);

			return {
				render: (width: number) => {
					const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
					const line = ` ${theme.fg("accent", spinner)} ${message}`;
					const help = ` ${theme.fg("dim", "esc to cancel")}`;
					const border = theme.fg("muted", "─".repeat(Math.max(10, Math.min(width, 80))));
					return [border, line, help, border];
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, "escape")) {
						controller.abort();
						finish({ ok: false, cancelled: true });
					}
				},
			};
		},
	);

	return result ?? { ok: false, cancelled: true };
}
