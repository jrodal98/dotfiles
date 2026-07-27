/**
 * ask_user tool - Interactive Q&A between the agent and the user.
 *
 * Instead of the agent dumping numbered questions into the terminal and the
 * user having to type "1. yes, 2. no, ...", the agent calls ask_user and the
 * user answers each question via an interactive TUI:
 *   - Single question: option list (or free-text editor if no options)
 *   - Multiple questions: tab bar to move between questions, then Submit
 *   - Every question with options also offers a "Type something." escape hatch
 *
 * Based on the pi questionnaire example.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

// Types
interface QuestionOption {
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	freeText: boolean; // no options -> pure free-text question
}

interface Answer {
	id: string;
	answer: string;
	wasCustom: boolean;
	index?: number;
}

interface AskUserDetails {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(
		Type.String({ description: "Optional description shown below the label" }),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description:
				"Short label for the tab bar when asking multiple questions, e.g. 'Scope', 'Naming' (defaults to Q1, Q2, ...)",
		}),
	),
	prompt: Type.String({ description: "The full question text to show the user" }),
	options: Type.Optional(
		Type.Array(QuestionOptionSchema, {
			description:
				"Suggested answers the user can pick from. Omit or leave empty for a free-text question.",
		}),
	),
});

const AskUserParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "One or more questions to ask the user",
	}),
});

export type AskUserInput = Static<typeof AskUserParams>;

function errorResult(message: string, questions: Question[] = []) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { questions, answers: [], cancelled: true } as AskUserDetails,
	};
}

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user one or more questions interactively and get structured answers back. " +
			"Each question can offer options to pick from, or be free-text. " +
			"Use this whenever you need clarification, preferences, or a decision from the user " +
			"instead of listing questions in your text response.",
		promptSnippet: "Ask the user clarifying questions interactively and receive their answers",
		promptGuidelines: [
			"When you have questions for the user, call ask_user instead of writing the questions in your response and waiting. Batch related questions into a single ask_user call.",
			"For ask_user, provide sensible options when likely answers are known; omit options for open-ended questions.",
		],
		parameters: AskUserParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return errorResult("Error: interactive UI not available (non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Validate question IDs: answers are keyed by id, so they must be non-empty and unique
			const seenIds = new Set<string>();
			for (const q of params.questions) {
				if (!q.id.trim()) {
					return errorResult("Error: Every question must have a non-empty id");
				}
				if (seenIds.has(q.id)) {
					return errorResult(`Error: Duplicate question id: ${q.id}`);
				}
				seenIds.add(q.id);
			}

			// Normalize questions
			const questions: Question[] = params.questions.map((q, i) => ({
				id: q.id,
				label: q.label || `Q${i + 1}`,
				prompt: q.prompt,
				options: q.options ?? [],
				freeText: !q.options || q.options.length === 0,
			}));

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			if (signal.aborted) {
				return errorResult("Aborted before the user was asked", questions);
			}

			// Let an agent abort (Esc/cancel) resolve the dialog instead of leaving it open
			let abortDialog: (() => void) | undefined;
			const onAbort = () => abortDialog?.();
			signal.addEventListener("abort", onAbort, { once: true });

			const result = await ctx.ui.custom<AskUserDetails>((tui, theme, _kb, done) => {
				// State
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = questions[0].freeText;
				let inputQuestionId: string | null = inputMode ? questions[0].id : null;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, Answer>();

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}
				abortDialog = () => submit(true);

				function currentQuestion(): Question | undefined {
					return questions[currentTab];
				}

				function currentOptions(): RenderOption[] {
					const q = currentQuestion();
					if (!q || q.freeText) return [];
					return [...q.options, { label: "Type something.", isOther: true }];
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				function enterQuestion() {
					const q = currentQuestion();
					optionIndex = 0;
					if (q?.freeText) {
						inputMode = true;
						inputQuestionId = q.id;
						editor.setText(answers.get(q.id)?.wasCustom ? answers.get(q.id)!.answer : "");
					} else {
						inputMode = false;
						inputQuestionId = null;
						editor.setText("");
					}
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					// Move to the next unanswered question, else Submit tab
					const next = questions.findIndex((q, i) => i > currentTab && !answers.has(q.id));
					const prior = questions.findIndex((q) => !answers.has(q.id));
					if (next !== -1) {
						currentTab = next;
					} else if (prior !== -1) {
						currentTab = prior;
					} else {
						currentTab = questions.length; // Submit tab
					}
					enterQuestion();
					refresh();
				}

				function saveAnswer(questionId: string, answer: string, wasCustom: boolean, index?: number) {
					answers.set(questionId, { id: questionId, answer, wasCustom, index });
				}

				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim();
					if (!trimmed) return; // require some text
					saveAnswer(inputQuestionId, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function moveTab(delta: number) {
					currentTab = (currentTab + delta + totalTabs) % totalTabs;
					enterQuestion();
					refresh();
				}

				function handleInput(data: string) {
					// Free-text editing mode
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							const q = currentQuestion();
							if (isMulti) {
								// leave editor; tab bar still navigable
								inputMode = false;
								inputQuestionId = null;
								editor.setText("");
								refresh();
							} else if (q && !q.freeText) {
								// back to options list
								inputMode = false;
								inputQuestionId = null;
								editor.setText("");
								refresh();
							} else {
								submit(true);
							}
							return;
						}
						// Allow tab navigation out of the editor in multi mode
						if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
							inputMode = false;
							inputQuestionId = null;
							moveTab(matchesKey(data, Key.tab) ? 1 : -1);
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();
					const opts = currentOptions();

					// Tab navigation (multi-question only)
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							moveTab(1);
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							moveTab(-1);
							return;
						}
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					// Free-text question not currently in edit mode (user tabbed away and back)
					if (q?.freeText) {
						if (matchesKey(data, Key.enter)) {
							enterQuestion();
							refresh();
							return;
						}
						if (matchesKey(data, Key.escape)) {
							submit(true);
							return;
						}
						return;
					}

					// Option navigation
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					// Number keys jump directly to an option (single keypress only,
					// so pastes/escape sequences starting with a digit don't move selection)
					if (data.length === 1 && /^[1-9]$/.test(data)) {
						const num = Number.parseInt(data, 10);
						if (num <= opts.length) {
							optionIndex = num - 1;
							refresh();
						}
						return;
					}

					// Select option
					if (matchesKey(data, Key.enter) && q) {
						const opt = opts[optionIndex];
						if (opt.isOther) {
							inputMode = true;
							inputQuestionId = q.id;
							editor.setText("");
							refresh();
							return;
						}
						saveAnswer(q.id, opt.label, false, optionIndex + 1);
						advanceAfterAnswer();
						return;
					}

					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const renderWidth = Math.max(1, width);
					const q = currentQuestion();
					const opts = currentOptions();

					function addWrapped(text: string) {
						lines.push(...wrapTextWithAnsi(text, renderWidth));
					}

					function addWrappedWithPrefix(prefix: string, text: string) {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							addWrapped(prefix + text);
							return;
						}
						const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					}

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					// Tab bar (multi-question only)
					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const box = isAnswered ? "■" : "□";
							const color = isAnswered ? "success" : "muted";
							const text = ` ${box} ${questions[i].label} `;
							const styled = isActive
								? theme.bg("selectedBg", theme.fg("text", text))
								: theme.fg(color, text);
							tabs.push(`${styled} `);
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						tabs.push(`${submitStyled} →`);
						addWrappedWithPrefix(" ", tabs.join(""));
						lines.push("");
					}

					function renderOptions() {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const label = `${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
							const color = selected || (isOther && inputMode) ? "accent" : "text";

							addWrappedWithPrefix(prefix, theme.fg(color, label));
							if (opt.description) {
								addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
							}
						}
					}

					// Content
					if (currentTab === questions.length) {
						// Submit tab
						addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Review answers")));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							const summary = answer
								? `${theme.fg("muted", `${question.label}: `)}${theme.fg(
										"text",
										(answer.wasCustom && !question.freeText ? "(wrote) " : "") + answer.answer,
									)}`
								: `${theme.fg("muted", `${question.label}: `)}${theme.fg("warning", "(unanswered)")}`;
							addWrappedWithPrefix(" ", summary);
						}
						lines.push("");
						if (allAnswered()) {
							addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
						} else {
							const missing = questions
								.filter((question) => !answers.has(question.id))
								.map((question) => question.label)
								.join(", ");
							addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
						}
					} else if (q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						lines.push("");
						if (q.freeText) {
							if (inputMode) {
								addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
								for (const line of editor.render(Math.max(1, renderWidth - 2))) {
									lines.push(` ${line}`);
								}
							} else {
								const existing = answers.get(q.id);
								if (existing) {
									addWrappedWithPrefix(" ", theme.fg("muted", "Current answer: ") + theme.fg("text", existing.answer));
								}
								addWrappedWithPrefix(" ", theme.fg("dim", "Press Enter to type an answer"));
							}
						} else {
							renderOptions();
							if (inputMode) {
								lines.push("");
								addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
								for (const line of editor.render(Math.max(1, renderWidth - 2))) {
									lines.push(` ${line}`);
								}
							}
						}
					}

					lines.push("");
					const help = inputMode
						? isMulti
							? "Enter to save answer • Tab next question • Esc leave editor"
							: "Enter to submit • Esc to go back"
						: isMulti
							? "Tab/←→ questions • ↑↓/1-9 select • Enter confirm • Esc cancel"
							: "↑↓/1-9 select • Enter confirm • Esc cancel";
					addWrappedWithPrefix(" ", theme.fg("dim", help));
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			signal.removeEventListener("abort", onAbort);

			if (result.cancelled) {
				const partial = result.answers;
				const text =
					partial.length > 0
						? `User cancelled before submitting. Partial answers (unconfirmed):\n${partial
								.map((a) => `- ${a.id}: ${a.answer}`)
								.join("\n")}`
						: "User cancelled without answering.";
				return { content: [{ type: "text", text }], details: result };
			}

			const answerLines = result.answers.map((a) => {
				const question = questions.find((qq) => qq.id === a.id);
				const label = question?.label || a.id;
				if (a.wasCustom) return `${label}: user wrote: ${a.answer}`;
				return `${label}: user selected: ${a.index}. ${a.answer}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as { id: string; label?: string; prompt: string }[]) || [];
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
			const labels = qs.map((q, i) => q.label || `Q${i + 1}`).join(", ");
			if (labels) text += theme.fg("dim", ` (${labels})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				const question = details.questions.find((q) => q.id === a.id);
				const label = question?.label || a.id;
				const wrote = a.wasCustom && question && !question.freeText ? theme.fg("muted", "(wrote) ") : "";
				const display = a.index ? `${a.index}. ${a.answer}` : a.answer;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", label)}: ${wrote}${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
