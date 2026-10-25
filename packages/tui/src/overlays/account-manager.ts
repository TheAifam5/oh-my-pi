import { HubPrefs, type HubPrefsField, type HubPrefsValue } from "./hub-prefs";
/** Fullscreen account list and typed account, limit, and project pin preference sheets. */

import type {
	TspPrefsControl,
	TspPickerAction,
	TspPickerColumn,
	TspPickerGroup,
	TspPickerItem,
	TspPickerProps,
	TspPickerScope,
} from "@oh-my-pi/pi-wire";
import {
	type Component,
	Input,
	matchesKey,
	routeSgrMouseInput,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../index";
import { node, span, text } from "../native/describe";
import {
	CLOSE_ACTION,
	type PickerEvent,
	picker,
	pickerAction,
	pickerActionHints,
	pickerEvent,
	pickerHits,
	pickerQuery,
} from "../native/picker";
import { providerMark } from "./model-browser";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { type NativeHint, hintsRow } from "../native/overlay";
import { theme } from "../theme";
import { sanitizeDisplaySingleLine } from "./extensions/display-text";
import { extractPrintableText, type KeyId } from "../keys";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import {
	describeHubFrame,
	describeHubSidebar,
	HubFrame,
	pagedHints,
	type SidebarEntry as HubSidebarEntry,
	type SidebarStyle,
} from "./hub-frame";

/** Most body lines the status or notice wraps to before it is cut with an ellipsis. */
const MAX_STATUS_LINES = 3;

/** One edit the host can apply to an account, addressed by `id`. */
export interface AccountManagerAction {
	/** Action id passed back to {@link AccountManagerDeps.apply}. */
	id: string;
	label: string;
	/** Current state of a toggle; undefined for a plain action. */
	on?: boolean;
	/** Asks for a text value first, prefilled with `initial`; `hint` describes the accepted text. */
	input?: { initial: string; hint: string };
	/** Why the action cannot be applied here; shown instead of applying. */
	readOnly?: string;
	/** The state the action was offered against, passed back so the host can refuse a stale edit. */
	expect?: string;
	/** Target-specific confirmation required before applying this action. */
	confirm?: string;
	control?: TspPrefsControl;
}

/** One editable property of an account, offered as a footer chip. */
export interface AccountManagerField extends AccountManagerAction {
	/** Current value as display text. */
	value: string;
	/** Single-key shortcut from the account list. */
	key?: KeyId;
	/** Actions presented as typed controls within the account's preference sheet. */
	choices?: AccountManagerAction[];
}
/** One column of the Tern account table: its cells are each row's {@link AccountManagerAccount.facts}`[id]`. */
export interface AccountManagerColumn {
	id: string;
	head: string;
	/** Higher stays visible longer when the table is narrow. */
	priority: number;
}

/** One stored account as the manager shows it, or one row of an {@link AccountManagerPage}. */
export interface AccountManagerAccount {
	/** Stable id, unique across providers and pages. */
	id: string;
	/** Provider id; empty for a page row that belongs to no provider. */
	provider: string;
	name?: string;
	/** Email, organization, or `API key <fingerprint>`; never key material. */
	identity: string;
	/** Short facts for the list row (`priority 10`, `drain`, `session pin`). */
	badges: string[];
	/** Table cells by column id; a column without a cell here is blank for this row. */
	facts?: Readonly<Record<string, string>>;
	/** The detail block of the selected account. */
	details: { label: string; value: string; tone?: "dim" | "warning" | "success" | "error" }[];
	fields: AccountManagerField[];
}

/** Outcome of an applied edit: a confirmation, a warning to show beside it, or the refusal. */
export interface AccountManagerResult {
	message?: string;
	warning?: string;
	/** The refusal; nothing was written. */
	error?: string;
}

/** A page listed after the providers (global limits, project pins); its rows edit like accounts. */
export interface AccountManagerPage {
	/** Stable id, unique among pages. */
	id: string;
	label: string;
	/** Text shown in place of the rows when there are none. */
	empty: string;
	rows: AccountManagerAccount[];
	/** Configured entries the sidebar counts; omitted counts every row. */
	count?: number;
	/** Table columns of this page's rows; absent: one column of the rows' badges. */
	columns?: AccountManagerColumn[];
}

/** Host-owned account listing and persistence. */
export interface AccountManagerDeps {
	load: () => AccountManagerAccount[];
	/** Table columns of account rows; absent: one column of the rows' badges. */
	accountColumns?: AccountManagerColumn[];
	/** Pages listed after the providers; their rows' edits go through {@link apply} by row id. */
	pages?: () => AccountManagerPage[];
	/**
	 * Apply `actionId` to an account. `value` is the typed text of an input action, or the target
	 * state (`on` or `off`) of a toggle; `expect` is the action's {@link AccountManagerAction.expect}.
	 */
	apply: (accountId: string, actionId: string, value?: string, expect?: string) => Promise<AccountManagerResult>;
	/** Re-read the host's stores before a reload the user asked for. */
	refresh?: () => Promise<void>;
}

export interface AccountManagerCallbacks {
	onCancel: () => void;
}

interface SidebarEntry extends HubSidebarEntry<"all" | "provider" | "page" | "separator"> {
	provider?: string;
	page?: AccountManagerPage;
}

type Notice = { tone: "success" | "warning" | "error"; text: string };

/** `account` with every host string made single-line display text, so no renderer passes embedded escapes through. */
function sanitizeAccount(account: AccountManagerAccount): AccountManagerAccount {
	const clean = sanitizeDisplaySingleLine;
	const action = <T extends AccountManagerAction>(entry: T): T => ({
		...entry,
		label: clean(entry.label),
		...(entry.input ? { input: { initial: clean(entry.input.initial), hint: clean(entry.input.hint) } } : {}),
		...(entry.readOnly !== undefined ? { readOnly: clean(entry.readOnly) } : {}),
		...(entry.confirm !== undefined ? { confirm: clean(entry.confirm) } : {}),
	});
	return {
		...account,
		...(account.name !== undefined ? { name: clean(account.name) } : {}),
		provider: clean(account.provider),
		identity: clean(account.identity),
		badges: account.badges.map(clean),
		...(account.facts
			? { facts: Object.fromEntries(Object.entries(account.facts).map(([key, value]) => [key, clean(value)])) }
			: {}),
		details: account.details.map(detail => ({ ...detail, label: clean(detail.label), value: clean(detail.value) })),
		fields: account.fields.map(field => ({
			...action(field),
			value: clean(field.value),
			...(field.choices ? { choices: field.choices.map(action) } : {}),
		})),
	};
}

/** Native list-item id of an account row. */
function accountItemId(account: AccountManagerAccount): string {
	return `account:${account.id}`;
}

function isEnter(data: string): boolean {
	return matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n";
}

/**
 * The fullscreen account manager. Hosted via
 * `ui.showOverlay(..., { fullscreen: true })`.
 */
export class AccountManagerComponent implements Component {
	#tui: TUI;
	#deps: AccountManagerDeps;
	#callbacks: AccountManagerCallbacks;

	#accounts: AccountManagerAccount[] = [];
	#pages: AccountManagerPage[] = [];
	#entries: SidebarEntry[] = [];
	#activeEntryId = "all";
	#focus: "scope" | "list" = "list";
	#rows: AccountManagerAccount[] = [];
	#rowTotal = 0;
	#rowIndex = 0;
	#listScroll = 0;
	#prefs: HubPrefs | undefined;
	#notice: Notice | null = null;
	#busy = false;
	#search = new Input();
	#searching = false;
	#confirm: { accountId: string; action: AccountManagerAction; value?: string; text: string } | undefined;
	/** Footer hint page `?` selected for the account row `id`; page 0 elsewhere. */
	#hintPage: { id: string; page: number } | undefined;
	/** Set once the overlay closed; a late apply or refresh result is dropped. */
	#closed = false;

	/** Bumped on every visible-state change; the described node is rebuilt when it moves. */
	#nativeVersion = 0;
	#nativeCache: { version: number; picker: boolean; node: NativeNode } | undefined;

	readonly #frame: HubFrame = new HubFrame(
		"Accounts",
		{ min: 16, max: 26 },
		(width, rows) =>
			this.#frame.renderSidebar(
				this.#entries,
				width,
				rows,
				{ id: this.#activeEntryId, focused: this.#focus === "scope", follow: true, clamp: false },
				this.#sidebarStyle,
			),
		(width, height) => this.#renderBody(width, Math.max(1, Math.floor(height ?? 10))),
	);
	/** First account row's offset in body-line coordinates. */
	#listRowStart = 2;

	constructor(tui: TUI, deps: AccountManagerDeps, callbacks: AccountManagerCallbacks) {
		this.#tui = tui;
		this.#deps = deps;
		this.#callbacks = callbacks;
		this.#reload();
	}

	invalidate(): void {
		this.#nativeVersion++;
		this.#frame.invalidate();
	}

	#requestRender(): void {
		if (this.#closed) return;
		this.#nativeVersion++;
		this.#tui.requestRender();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Data
	// ═══════════════════════════════════════════════════════════════════════

	#reload(): void {
		const selectedId = this.#selected()?.id;
		try {
			this.#accounts = this.#deps.load().map(sanitizeAccount);
		} catch (error) {
			this.#accounts = [];
			this.#notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
		}
		const counts = new Map<string, number>();
		for (const account of this.#accounts) counts.set(account.provider, (counts.get(account.provider) ?? 0) + 1);
		const entries: SidebarEntry[] = [
			{ id: "all", kind: "all", label: "All accounts", annotation: String(this.#accounts.length) },
		];
		if (counts.size > 0) entries.push({ id: "sep:providers", kind: "separator", label: "" });
		for (const [provider, count] of counts) {
			entries.push({
				id: `provider:${provider}`,
				kind: "provider",
				label: sanitizeDisplaySingleLine(provider),
				provider,
				annotation: String(count),
			});
		}
		try {
			this.#pages = (this.#deps.pages?.() ?? []).map(page => ({
				...page,
				label: sanitizeDisplaySingleLine(page.label),
				empty: sanitizeDisplaySingleLine(page.empty),
				rows: page.rows.map(sanitizeAccount),
			}));
		} catch (error) {
			this.#pages = [];
			this.#notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
		}
		if (this.#pages.length > 0) entries.push({ id: "sep:pages", kind: "separator", label: "" });
		for (const page of this.#pages) {
			entries.push({
				id: `page:${page.id}`,
				kind: "page",
				label: page.label,
				page,
				annotation: String(page.count ?? page.rows.length),
			});
		}
		this.#entries = entries;
		if (!entries.some(entry => entry.id === this.#activeEntryId)) this.#activeEntryId = "all";
		this.#buildRows();
		const index = this.#rows.findIndex(account => account.id === selectedId);
		this.#rowIndex = index >= 0 ? index : Math.min(this.#rowIndex, Math.max(0, this.#rows.length - 1));
	}

	#activeEntry(): SidebarEntry {
		return this.#entries.find(entry => entry.id === this.#activeEntryId) ?? this.#entries[0]!;
	}

	#buildRows(): void {
		const selectedId = this.#selected()?.id;
		const entry = this.#activeEntry();
		const rows =
			entry.kind === "provider"
				? this.#accounts.filter(account => account.provider === entry.provider)
				: entry.kind === "page"
					? (entry.page?.rows ?? [])
					: this.#accounts;
		this.#rowTotal = rows.length;
		const tokens = this.#search.getValue().toLowerCase().split(/\s+/).filter(Boolean);
		this.#rows = tokens.length
			? rows.filter(account =>
					tokens.every(token =>
						`${account.name ?? ""} ${account.identity} ${account.provider}`.toLowerCase().includes(token),
					),
				)
			: rows;
		const index = this.#rows.findIndex(account => account.id === selectedId);
		this.#rowIndex = index >= 0 ? index : 0;
		this.#listScroll = 0;
	}

	#clearSearch(): boolean {
		if (!this.#searching && !this.#search.getValue()) return false;
		this.#searching = false;
		this.#search.setValue("");
		this.#buildRows();
		return true;
	}

	#emptyText(): string {
		if (this.#search.getValue().trim()) return "No accounts match your search.";
		const entry = this.#activeEntry();
		return entry.kind === "page" ? (entry.page?.empty ?? "") : "No stored accounts. Log in with /login.";
	}

	#selected(): AccountManagerAccount | undefined {
		return this.#rows[this.#rowIndex];
	}

	#account(id: string): AccountManagerAccount | undefined {
		return (
			this.#accounts.find(account => account.id === id) ??
			this.#pages.flatMap(page => page.rows).find(row => row.id === id)
		);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Edits
	// ═══════════════════════════════════════════════════════════════════════

	#openPrefs(account: AccountManagerAccount, focus?: string): void {
		this.#prefs = new HubPrefs(
			this.#accountTitle(account),
			() => this.#accountFields(account.id),
			() => {
				this.#prefs = undefined;
				this.#requestRender();
			},
			() => this.#requestRender(),
		);
		if (focus) {
			const field = this.#accountFields(account.id).find(field => field.id === focus);
			if (field?.control.k === "text" || field?.control.k === "number") this.#prefs.startEditing(focus);
			else this.#prefs.focus(focus);
		}
	}

	#accountFields(accountId: string): HubPrefsField[] {
		const account = this.#account(accountId);
		if (!account) return [];
		const rows: HubPrefsField[] = [];
		const add = (action: AccountManagerAction, parent?: AccountManagerField) => {
			const control: TspPrefsControl =
				action.control ??
				(action.on !== undefined
					? { k: "switch", on: action.on }
					: action.input
						? { k: "text", value: action.input.initial }
						: { k: "action", label: action.label, act: action.id });
			rows.push({
				id: action.id,
				label: parent ? `${parent.label}: ${action.label}` : action.label,
				hint: action.input?.hint,
				disabled: parent?.readOnly ?? action.readOnly,
				control,
				initial: control.k === "number" ? action.input?.initial : undefined,
				apply: async value => {
					if (action.confirm) {
						this.#confirm = {
							accountId,
							action,
							value: typeof value === "boolean" ? (value ? "on" : "off") : undefined,
							text: sanitizeDisplaySingleLine(
								`${action.confirm} — ${this.#accountTitle(account)} (${account.identity})`,
							),
						};
						this.#prefs = undefined;
						return undefined;
					}
					return this.#apply(accountId, action, value);
				},
			});
		};
		for (const field of account.fields) {
			if (field.choices && (field.id === "auto-redeem" || field.id === "pin:account")) {
				const choices = field.choices;
				rows.push({
					id: field.id,
					label: field.label,
					disabled: field.readOnly,
					control: {
						k: "choice",
						value: choices.find(choice => choice.on)?.id ?? "",
						options: choices.map(choice => ({ value: choice.id, label: choice.label })),
					},
					apply: value => {
						const action = choices.find(choice => choice.id === value);
						return action ? this.#apply(accountId, action, null) : "Unknown choice";
					},
				});
			} else if (field.choices) {
				for (const choice of field.choices) add(choice, field);
			} else add(field);
		}
		return rows;
	}

	async #apply(accountId: string, action: AccountManagerAction, value?: HubPrefsValue): Promise<string | undefined> {
		this.#busy = true;
		let refusal: string | undefined;
		try {
			const result = await this.#deps.apply(
				accountId,
				action.id,
				value === null || value === undefined
					? undefined
					: typeof value === "boolean"
						? value
							? "on"
							: "off"
						: String(value),
				action.expect,
			);
			refusal = result.error;
			this.#notice = result.warning
				? { tone: "warning", text: [result.message, result.warning].filter(Boolean).join(" ") }
				: result.message
					? { tone: "success", text: result.message }
					: null;
		} catch (error) {
			refusal = error instanceof Error ? error.message : String(error);
		} finally {
			this.#busy = false;
		}
		if (this.#closed) return refusal;
		if (!refusal) this.#reload();
		this.#requestRender();
		return refusal;
	}

	#close(): void {
		this.#closed = true;
		this.#callbacks.onCancel();
	}

	async #refresh(): Promise<void> {
		this.#busy = true;
		this.#notice = null;
		try {
			await this.#deps.refresh?.();
		} catch (error) {
			this.#notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
		} finally {
			this.#busy = false;
		}
		if (this.#closed) return;
		this.#reload();
		this.#requestRender();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Input
	// ═══════════════════════════════════════════════════════════════════════

	handleInput(data: string): void {
		this.#nativeVersion++;
		if (this.#busy) {
			if (matchesSelectCancel(data)) this.#close();
			return;
		}
		if (this.#confirm) {
			if (matchesSelectCancel(data)) this.#confirm = undefined;
			else if (isEnter(data)) this.#confirmApply();
			this.#requestRender();
			return;
		}
		if (this.#prefs) {
			this.#prefs.handleInput(data);
			return;
		}
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			this.#requestRender();
			return;
		}
		if (this.#searching) {
			if (matchesSelectCancel(data)) this.#clearSearch();
			else if (isEnter(data)) this.#searching = false;
			else if (matchesSelectUp(data) || matchesSelectDown(data)) {
				this.#rowIndex = Math.max(
					0,
					Math.min(this.#rows.length - 1, this.#rowIndex + (matchesSelectUp(data) ? -1 : 1)),
				);
			} else {
				this.#search.handleInput(data);
				this.#buildRows();
			}
			this.#requestRender();
			return;
		}
		if (matchesSelectCancel(data)) {
			if (!this.#clearSearch()) this.#close();
			return;
		}
		if (extractPrintableText(data) === "/") {
			this.#searching = true;
			this.#focus = "list";
			this.#requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			void this.#refresh();
		} else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = this.#focus === "scope" ? "list" : "scope";
		} else if (matchesKey(data, "left")) {
			this.#focus = "scope";
		} else if (matchesKey(data, "right")) {
			this.#focus = "list";
		} else if (matchesSelectUp(data) || matchesSelectDown(data)) {
			const delta = matchesSelectUp(data) ? -1 : 1;
			if (this.#focus === "scope") this.#moveSidebar(delta);
			else this.#rowIndex = Math.max(0, Math.min(this.#rows.length - 1, this.#rowIndex + delta));
		} else if (isEnter(data)) {
			const account = this.#selected();
			if (this.#focus === "scope") this.#focus = "list";
			else if (account) this.#openPrefs(account);
		} else if (this.#focus === "list") {
			const account = this.#selected();
			const field = account?.fields.find(
				candidate => candidate.key !== undefined && matchesKey(data, candidate.key),
			);
			if (account && field) {
				this.#openPrefs(account, field.id);
			} else if (account && data === "?") {
				const page = this.#hintPage?.id === account.id ? this.#hintPage.page + 1 : 1;
				this.#hintPage = { id: account.id, page };
			} else if (extractPrintableText(data) !== undefined) {
				this.#searching = true;
				this.#search.handleInput(data);
				this.#buildRows();
			}
		}
		this.#requestRender();
	}

	#confirmApply(): void {
		const pending = this.#confirm;
		this.#confirm = undefined;
		if (pending) void this.#apply(pending.accountId, pending.action, pending.value);
	}

	#moveSidebar(delta: number): void {
		const count = this.#entries.length;
		let index = Math.max(
			0,
			this.#entries.findIndex(entry => entry.id === this.#activeEntryId),
		);
		for (let step = 0; step < count; step++) {
			index = (index + delta + count) % count;
			const entry = this.#entries[index];
			if (entry && entry.kind !== "separator") {
				this.#selectEntry(entry);
				return;
			}
		}
	}

	#selectEntry(entry: SidebarEntry): void {
		this.#activeEntryId = entry.id;
		this.#buildRows();
		this.#rowIndex = 0;
		this.#listScroll = 0;
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const { bodyHeight, contentLine, overSidebar, overBody } = this.#frame.locate(event.row, event.col);
		if (event.wheel !== null) {
			if (overSidebar) this.#frame.scrollSidebar(event.wheel, bodyHeight, this.#entries.length);
			else if (overBody) {
				this.#rowIndex = Math.max(0, Math.min(this.#rows.length - 1, this.#rowIndex + event.wheel));
			}
			return true;
		}
		if (!event.leftClick) return true;
		if (overSidebar) {
			const entry = this.#entries[this.#frame.sidebarScroll + contentLine];
			if (entry && entry.kind !== "separator") {
				this.#selectEntry(entry);
				this.#focus = "scope";
			}
		} else if (overBody) {
			this.#focus = "list";
			const index = contentLine - this.#listRowStart + this.#listScroll;
			const account = this.#rows[index];
			if (account) {
				if (index === this.#rowIndex) this.#openPrefs(account);
				else this.#rowIndex = index;
			}
		}
		return true;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════════

	#terminalRows(): number {
		return Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
	}

	#sidebarStyle = (entry: SidebarEntry): SidebarStyle => ({
		icon: theme.fg("accent", entry.kind === "all" ? theme.icon.model : theme.status.enabled),
		annotation: theme.fg("dim", entry.annotation ?? ""),
	});

	#statusText(): { text: string; tone: "success" | "warning" | "error" | "muted" } {
		if (this.#busy) return { text: "Saving…", tone: "muted" };
		if (this.#notice) return { text: sanitizeDisplaySingleLine(this.#notice.text), tone: this.#notice.tone };
		const entry = this.#activeEntry();
		const scope =
			entry.kind === "provider" ? `${entry.label} accounts` : entry.kind === "page" ? entry.label : "All accounts";
		const count = entry.page?.count ?? this.#rows.length;
		return { text: `${scope} · ${count}`, tone: "muted" };
	}

	#accountTitle(account: AccountManagerAccount): string {
		return sanitizeDisplaySingleLine(account.name ?? "(unnamed)");
	}

	#renderBody(width: number, rows: number): string[] {
		const status = this.#statusText();
		const statusLines = wrapTextWithAnsi(status.text, Math.max(1, width - 1));
		if (statusLines.length > MAX_STATUS_LINES) {
			statusLines.length = MAX_STATUS_LINES;
			statusLines[MAX_STATUS_LINES - 1] = truncateToWidth(`${statusLines[MAX_STATUS_LINES - 1]}…`, width - 1);
		}
		const lines: string[] = [...statusLines.map(line => theme.fg(status.tone, ` ${line}`)), ""];
		if (this.#searching || this.#search.getValue()) {
			lines.push(truncateToWidth(` Search: ${sanitizeDisplaySingleLine(this.#search.getValue())}`, width), "");
		}
		this.#listRowStart = lines.length;
		const selected = this.#selected();
		const detailLines: string[] = [];
		if (selected) {
			let labelWidth = 0;
			for (const detail of selected.details) labelWidth = Math.max(labelWidth, visibleWidth(detail.label));
			const valueWidth = Math.max(1, width - labelWidth - 3);
			for (const detail of selected.details) {
				const wrapped = wrapTextWithAnsi(sanitizeDisplaySingleLine(detail.value), valueWidth);
				wrapped.forEach((value, index) => {
					const label = index === 0 ? theme.fg("muted", detail.label.padEnd(labelWidth)) : " ".repeat(labelWidth);
					detailLines.push(
						truncateToWidth(` ${label}  ${detail.tone ? theme.fg(detail.tone, value) : value}`, width),
					);
				});
			}
		}
		const detailRows = selected ? Math.min(detailLines.length + 2, Math.max(0, rows - 6)) : 2;
		const visibleRows = Math.max(1, rows - lines.length - detailRows);
		if (this.#rowIndex < this.#listScroll) this.#listScroll = this.#rowIndex;
		else if (this.#rowIndex >= this.#listScroll + visibleRows) this.#listScroll = this.#rowIndex - visibleRows + 1;
		let nameWidth = 0;
		for (const account of this.#rows) nameWidth = Math.max(nameWidth, visibleWidth(this.#accountTitle(account)));
		const multiProvider = this.#activeEntry().kind !== "provider";
		for (let i = this.#listScroll; i < Math.min(this.#rows.length, this.#listScroll + visibleRows); i++) {
			const account = this.#rows[i]!;
			const active = i === this.#rowIndex;
			const cursor = active && this.#focus === "list" ? theme.fg("accent", theme.nav.cursor) : " ";
			const name = this.#accountTitle(account).padEnd(nameWidth);
			const provider =
				multiProvider && account.provider
					? `${theme.fg("dim", sanitizeDisplaySingleLine(account.provider))}  `
					: "";
			let line = ` ${cursor} ${active ? theme.bold(theme.fg("accent", name)) : name}  ${provider}${sanitizeDisplaySingleLine(account.identity)}`;
			const badges = theme.fg("dim", sanitizeDisplaySingleLine(account.badges.join(" · ")));
			const lineWidth = visibleWidth(line);
			const badgeWidth = visibleWidth(badges);
			if (badgeWidth > 0 && lineWidth + badgeWidth + 2 <= width) {
				line = `${line}${" ".repeat(width - lineWidth - badgeWidth - 1)}${badges}`;
			}
			lines.push(truncateToWidth(line, width));
		}
		if (this.#rows.length === 0) {
			for (const line of wrapTextWithAnsi(this.#emptyText(), Math.max(1, width - 1)))
				lines.push(theme.fg("dim", ` ${line}`));
		}
		while (lines.length < rows - detailRows) lines.push("");
		lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
		if (selected) {
			lines.push(
				truncateToWidth(
					` ${theme.bold(theme.fg("accent", this.#accountTitle(selected)))}  ${theme.fg("dim", sanitizeDisplaySingleLine([selected.provider, selected.identity].filter(Boolean).join(" · ")))}`,
					width,
				),
			);
			lines.push(...detailLines);
		} else {
			lines.push(theme.fg("dim", " Select an account to inspect"));
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#footerHint(width: number): string {
		const account = this.#selected();
		const page = account && this.#hintPage?.id === account.id ? this.#hintPage.page : 0;
		const actions = pickerActionHints(this.#pickerActions(account)).map(
			hint => `${hint.keys.length ? `${formatKeyHints(hint.keys)} ` : ""}${hint.label}`,
		);
		return pagedHints(
			[
				...actions,
				`${editorKeys("tui.select.up", "tui.select.down")} ${this.#focus === "scope" ? "providers" : "rows"}`,
			],
			width,
			page,
		);
	}

	#renderFooter(width: number): string {
		if (this.#confirm) {
			return truncateToWidth(
				`${this.#confirm.text} · ${formatKeyHint("enter")} confirm · ${editorKey("tui.select.cancel")} cancel`,
				width,
			);
		}
		return this.#frame.renderFooter(width, this.#footerHint(width));
	}

	render(width: number): readonly string[] {
		if (this.#prefs) return this.#prefs.render(width);
		return this.#frame.render(width, this.#terminalRows(), this.#entries, this.#renderFooter(width - 4));
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Native (TSP) description
	// ═══════════════════════════════════════════════════════════════════════

	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker");
	}

	describe(cx: DescribeContext): NativeNode {
		if (this.#prefs) return this.#prefs.describe(cx);
		const usePicker = cx.supports("picker");
		const cached = this.#nativeCache;
		if (cached?.version === this.#nativeVersion && cached.picker === usePicker) return cached.node;
		if (usePicker) {
			const described = this.#describePicker(cx);
			this.#nativeCache = { version: this.#nativeVersion, picker: true, node: described };
			return described;
		}
		const footer: NativeChild[] = [];
		if (this.#confirm) footer.push(text([span(this.#confirm.text, "warning")]));
		footer.push(hintsRow(this.#footerHints()));
		const described = describeHubFrame(
			"omp.hub.accounts",
			"Accounts",
			describeHubSidebar(this.#entries, this.#activeEntryId, this.#sidebarStyle, "providers"),
			this.#describeBody(),
			node("col", { gap: "xs" }, footer, "footer"),
		);
		this.#nativeCache = { version: this.#nativeVersion, picker: false, node: described };
		return described;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#busy) {
			if (event.type === "action" && event.act === CLOSE_ACTION.id) this.#close();
			return;
		}
		if (this.#prefs) {
			this.#prefs.handleNativeEvent(event);
			return;
		}
		const picked = pickerEvent(event);
		if (picked) {
			if (this.#busy && !(picked.kind === "action" && picked.act === CLOSE_ACTION.id)) return;
			this.#handlePickerEvent(picked);
			this.#requestRender();
			return;
		}
		if ((event.type !== "select" && event.type !== "activate") || this.#busy) return;
		const target = event.key.slice(event.key.lastIndexOf("/") + 1);
		const activate = event.type === "activate";
		if (target === "accounts") {
			const index = this.#rows.findIndex(account => accountItemId(account) === event.item);
			if (index < 0) return;
			this.#focus = "list";
			this.#rowIndex = index;
			if (activate) this.#openPrefs(this.#rows[index]!);
		} else if (target === "providers") {
			const entry = this.#entries.find(candidate => candidate.id === event.item);
			if (!entry || entry.kind === "separator") return;
			this.#selectEntry(entry);
			this.#focus = activate ? "list" : "scope";
		} else {
			return;
		}
		this.#requestRender();
	}

	// ─── Tern picker table ───────────────────────────────────────────────

	/** The Tern account table: providers and pages as scopes, rows with one column per fact, the selected row's details as preview. */
	#describePicker(_cx: DescribeContext): NativeNode {
		const entry = this.#activeEntry();
		const selected = this.#selected();
		const status = this.#statusText();
		const columns = this.#pickerColumns();
		const multiProvider = entry.kind === "all";
		const items: TspPickerItem[] = this.#rows.map(account => ({
			id: accountItemId(account),
			label: account.name ?? "(unnamed)",
			detail: multiProvider && account.provider ? `${account.provider} · ${account.identity}` : account.identity,
			...(account.name === undefined ? { tone: "muted" as const } : {}),
			...(multiProvider && account.provider ? { mark: providerMark(account.provider) } : {}),
			facts: this.#rowFacts(account),
			badges: account.badges.map(text => ({ text })),
			hits: pickerHits(account.name ?? "(unnamed)", this.#search.getValue().toLowerCase().split(/\s+/)),
		}));
		const props: TspPickerProps = {
			title: "Accounts",
			...(this.#busy || this.#notice ? { subtitle: [span(status.text, status.tone)] } : {}),
			icon: "key",
			noun: entry.kind === "page" ? "rows" : "accounts",
			size: "lg",
			layout: "rows",
			preview: "side",
			...pickerQuery(this.#searching || this.#search.getValue() ? this.#search : null),
			placeholder: "Search accounts…",
			scopes: this.#pickerScopes(),
			scope: entry.id,
			columns,
			items,
			order: this.#pickerOrder(multiProvider),
			selected: selected ? accountItemId(selected) : null,
			total: this.#rowTotal,
			empty: this.#emptyText(),
			state: this.#busy ? "loading" : this.#notice?.tone === "error" ? "error" : "ready",
			message: this.#busy || this.#notice ? status.text : undefined,
			confirm: this.#confirm ? { text: this.#confirm.text, act: "confirm", label: "Confirm" } : null,
			actions: this.#pickerActions(selected),
			focus: this.#focus === "scope" ? "scopes" : "list",
		};
		const preview: NativeChild[] = [this.#detailSection(selected)];
		return picker(props, preview);
	}

	/** Columns of the active scope that at least one row fills, else one column of the rows' badges. */
	#pickerColumns(): TspPickerColumn[] {
		const entry = this.#activeEntry();
		const declared = entry.kind === "page" ? entry.page?.columns : this.#deps.accountColumns;
		if (!declared) return [{ id: "badges", head: "Details", format: "dim", priority: 1 }];
		return declared
			.filter(column => this.#rows.some(account => (account.facts?.[column.id] ?? "").length > 0))
			.map((column, index) => ({
				id: column.id,
				head: column.head,
				format: index === 0 ? "text" : "dim",
				priority: column.priority,
			}));
	}

	/** `account`'s table cells: its facts, or its badges when the scope declares no columns. */
	#rowFacts(account: AccountManagerAccount): Record<string, string> {
		const entry = this.#activeEntry();
		const declared = entry.kind === "page" ? entry.page?.columns : this.#deps.accountColumns;
		if (!declared) return account.badges.length > 0 ? { badges: account.badges.join(" · ") } : {};
		const facts: Record<string, string> = {};
		for (const [key, value] of Object.entries(account.facts ?? {})) if (value.length > 0) facts[key] = value;
		return facts;
	}

	/** Row order: All accounts groups rows under a head per provider; other scopes list rows as they are. */
	#pickerOrder(byProvider: boolean): (string | TspPickerGroup)[] {
		if (!byProvider) return this.#rows.map(accountItemId);
		const order: (string | TspPickerGroup)[] = [];
		let head: (TspPickerGroup & { count: number }) | undefined;
		for (const account of this.#rows) {
			if (head?.group !== account.provider) {
				head = { group: account.provider, label: account.provider || "Other", count: 0 };
				order.push(head);
			}
			head.count++;
			order.push(accountItemId(account));
		}
		return order;
	}

	/** The sidebar as picker scopes: All accounts, one per provider, then the host's pages. */
	#pickerScopes(): TspPickerScope[] {
		const scopes: TspPickerScope[] = [];
		for (const entry of this.#entries) {
			const count = Number(entry.annotation ?? 0);
			if (entry.kind === "all") scopes.push({ id: entry.id, label: entry.label, icon: "users", count });
			else if (entry.kind === "provider") {
				scopes.push({
					id: entry.id,
					label: entry.label,
					mark: providerMark(entry.provider ?? entry.label),
					group: "Providers",
					count,
				});
			} else if (entry.kind === "page") {
				scopes.push({ id: entry.id, label: entry.label, icon: "settings", group: "Policies", count });
			}
		}
		return scopes;
	}

	/** Account actions, field shortcuts, reload, and close. */
	#pickerActions(selected: AccountManagerAccount | undefined): TspPickerAction[] {
		if (this.#confirm)
			return [
				pickerAction("confirm", "Confirm", "enter", { primary: true, danger: true }),
				pickerAction("cancel", "Cancel", "escape"),
			];
		if (this.#searching)
			return [pickerAction("searchDone", "Done searching", "enter"), { ...CLOSE_ACTION, label: "Clear search" }];
		if (this.#focus === "scope")
			return [
				pickerAction("focusList", "Accounts", "enter"),
				pickerAction("search", "Search", "/"),
				pickerAction("reload", "Reload", "ctrl+r"),
				this.#search.getValue() ? { ...CLOSE_ACTION, label: "Clear search" } : CLOSE_ACTION,
			];
		const actions: TspPickerAction[] = [];
		if (selected) {
			actions.push(pickerAction("edit", "Edit", "enter", { primary: true }));
			for (const field of selected.fields) {
				if (!field.key) continue;
				actions.push(
					pickerAction(`field:${field.id}`, field.label, field.key, {
						...(field.readOnly ? { disabled: field.readOnly } : {}),
						...(field.confirm ? { danger: true } : {}),
					}),
				);
			}
		}
		actions.push(pickerAction("search", "Search", "/"));
		actions.push(pickerAction("reload", "Reload", "ctrl+r"));
		actions.push(this.#search.getValue() ? { ...CLOSE_ACTION, label: "Clear search" } : CLOSE_ACTION);
		return actions;
	}

	#handlePickerEvent(event: PickerEvent): void {
		if (this.#confirm) {
			if (event.kind === "action" && event.act === "confirm") this.#confirmApply();
			else if (event.kind === "action" && (event.act === "cancel" || event.act === CLOSE_ACTION.id))
				this.#confirm = undefined;
			return;
		}
		if (event.kind !== "action") {
			const index = this.#rows.findIndex(account => accountItemId(account) === event.item);
			if (index < 0) return;
			this.#focus = "list";
			this.#rowIndex = index;
			if (event.kind === "activate") this.#openPrefs(this.#rows[index]!);
			return;
		}
		const { act, value } = event;
		if (act === CLOSE_ACTION.id) {
			if (!this.#clearSearch()) this.#close();
		} else if (act === "cancel") {
			this.#prefs = undefined;
		} else if (act === "search") {
			{
				this.#searching = true;
				this.#focus = "list";
			}
		} else if (act === "searchDone") {
			this.#searching = false;
		} else if (act === "focusList") {
			this.#focus = "list";
		} else if (act === "scope") {
			const entry = this.#entries.find(candidate => candidate.id === value);
			if (!entry || entry.kind === "separator") return;
			this.#selectEntry(entry);
			this.#focus = "list";
		} else if (act === "reload") {
			void this.#refresh();
		} else {
			const account = this.#selected();
			if (!account) return;
			this.#focus = "list";
			if (act === "edit") this.#openPrefs(account);
			else if (act.startsWith("field:")) {
				const field = account.fields.find(candidate => `field:${candidate.id}` === act);
				if (field) this.#openPrefs(account, field.id);
			}
		}
	}

	/** The selected row's detail section: its name and identity, then its labelled details. */
	#detailSection(selected: AccountManagerAccount | undefined): NativeNode {
		if (!selected) return node("section", {}, [text([span("Select an account to inspect", "dim")])], "detail");
		return node(
			"section",
			{ head: [span(selected.name ?? "(unnamed)", "accent strong"), span(`  ${selected.identity}`, "dim")] },
			[
				node("kv", {
					items: selected.details.map(detail => ({
						k: [span(detail.label, "muted")],
						v: [span(detail.value, detail.tone)],
					})),
					layout: "grid",
				}),
			],
			"detail",
		);
	}

	#describeBody(): NativeNode {
		const status = this.#statusText();
		const selected = this.#selected();
		const multiProvider = this.#activeEntry().kind !== "provider";
		const items = this.#rows.map(account =>
			node(
				"item",
				{
					label: [span(account.name ?? "(unnamed)", account.name ? "strong" : "dim")],
					detail: [
						span(
							multiProvider && account.provider ? `${account.provider} · ${account.identity}` : account.identity,
							"dim",
						),
					],
					value: account.badges.length > 0 ? [span(account.badges.join(" · "), "dim")] : undefined,
				},
				undefined,
				accountItemId(account),
			),
		);
		const children: NativeChild[] = [
			node("text", { spans: [span(status.text, status.tone)], wrap: "word" }, undefined, "status"),
			node(
				"list",
				{
					selected: selected ? accountItemId(selected) : null,
					virtual: true,
					grow: 1,
					tone: this.#focus === "list" ? "accent" : undefined,
					aria: "Accounts",
				},
				items,
				"accounts",
			),
		];
		children.push(this.#detailSection(selected));
		return node("col", { gap: "sm", grow: 1 }, children, "body");
	}

	#footerHints(): NativeHint[] {
		return pickerActionHints(this.#pickerActions(this.#selected()));
	}
}
