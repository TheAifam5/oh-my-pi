/**
 * Fullscreen /account manager, shown on the alternate screen like /models.
 *
 * A sidebar of providers (All accounts, then one entry per provider), a body
 * listing the stored accounts with the selected account's details below, and
 * a footer that turns into a chip strip while editing. Enter on an account
 * opens its field strip; a field either applies at once (toggles), opens a
 * text input, or opens a second strip of choices. Every field also has a
 * single-key shortcut from the list. The host owns meaning and persistence:
 * fields arrive described by {@link AccountManagerDeps.load} and edits go
 * back through {@link AccountManagerDeps.apply} by action id.
 */

import type { TspSpan } from "@oh-my-pi/pi-wire";
import {
	type Component,
	Input,
	matchesKey,
	routeSgrMouseInput,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../index";
import { col, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, type NativeHint, hintsRow } from "../native/overlay";
import { theme } from "../theme";
import { sanitizeDisplaySingleLine } from "./extensions/display-text";
import type { KeyId } from "../keys";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import {
	describeHubFrame,
	describeHubSidebar,
	HubFrame,
	moveStripSelection,
	type SidebarEntry as HubSidebarEntry,
	type SidebarStyle,
	type StripChip as HubStripChip,
	type StripState as HubStripState,
} from "./hub-frame";

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
}

/** One editable property of an account, offered as a footer chip. */
export interface AccountManagerField extends AccountManagerAction {
	/** Current value as display text. */
	value: string;
	/** Single-key shortcut from the account list. */
	key?: KeyId;
	/** Opens a second strip of these actions instead of applying the field itself. */
	choices?: AccountManagerAction[];
}

/** One stored account as the manager shows it. */
export interface AccountManagerAccount {
	/** Stable id, unique across providers. */
	id: string;
	provider: string;
	name?: string;
	/** Email, organization, or `API key <fingerprint>`; never key material. */
	identity: string;
	/** Short facts for the list row (`priority 10`, `drain`, `session pin`). */
	badges: string[];
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

/** Host-owned account listing and persistence. */
export interface AccountManagerDeps {
	load: () => AccountManagerAccount[];
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

interface SidebarEntry extends HubSidebarEntry<"all" | "provider" | "separator"> {
	provider?: string;
}

type StripChip = HubStripChip<AccountManagerAction & { choices?: AccountManagerAction[] }>;

type StripState =
	| (HubStripState<StripChip> & { kind: "chips"; accountId: string; field?: AccountManagerField })
	| { kind: "input"; accountId: string; action: AccountManagerAction; input: Input };

type Notice = { tone: "success" | "warning" | "error"; text: string };

/** `account` with every host string made single-line display text, so no renderer passes embedded escapes through. */
function sanitizeAccount(account: AccountManagerAccount): AccountManagerAccount {
	const clean = sanitizeDisplaySingleLine;
	const action = <T extends AccountManagerAction>(entry: T): T => ({
		...entry,
		label: clean(entry.label),
		...(entry.input ? { input: { initial: clean(entry.input.initial), hint: clean(entry.input.hint) } } : {}),
		...(entry.readOnly !== undefined ? { readOnly: clean(entry.readOnly) } : {}),
	});
	return {
		...account,
		...(account.name !== undefined ? { name: clean(account.name) } : {}),
		provider: clean(account.provider),
		identity: clean(account.identity),
		badges: account.badges.map(clean),
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
	#entries: SidebarEntry[] = [];
	#activeEntryId = "all";
	#focus: "scope" | "list" = "list";
	#rows: AccountManagerAccount[] = [];
	#rowIndex = 0;
	#listScroll = 0;
	#strip: StripState | null = null;
	#notice: Notice | null = null;
	#busy = false;
	/** Set once the overlay closed; a late apply or refresh result is dropped. */
	#closed = false;

	/** Bumped on every visible-state change; the described node is rebuilt when it moves. */
	#nativeVersion = 0;
	#nativeCache: { version: number; node: NativeNode } | undefined;

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
		const entry = this.#activeEntry();
		this.#rows =
			entry.kind === "provider"
				? this.#accounts.filter(account => account.provider === entry.provider)
				: this.#accounts;
	}

	#selected(): AccountManagerAccount | undefined {
		return this.#rows[this.#rowIndex];
	}

	#account(id: string): AccountManagerAccount | undefined {
		return this.#accounts.find(account => account.id === id);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Edits
	// ═══════════════════════════════════════════════════════════════════════

	#openFieldStrip(account: AccountManagerAccount): void {
		this.#strip = {
			kind: "chips",
			accountId: account.id,
			chips: account.fields.map(field => ({
				label: `${field.label}: ${field.value}`,
				styled: `${theme.fg(field.readOnly ? "dim" : "accent", field.label)}${theme.fg("dim", `: ${sanitizeDisplaySingleLine(field.value)}`)}`,
				action: field,
			})),
			index: 0,
		};
	}

	#openChoiceStrip(account: AccountManagerAccount, field: AccountManagerField): void {
		const choices = field.choices ?? [];
		this.#strip = {
			kind: "chips",
			accountId: account.id,
			field,
			chips: choices.map(choice => ({
				label: choice.label,
				styled: choice.readOnly
					? theme.fg("dim", sanitizeDisplaySingleLine(choice.label))
					: choice.on
						? theme.fg("accent", `${theme.status.enabled} ${sanitizeDisplaySingleLine(choice.label)}`)
						: theme.fg("muted", sanitizeDisplaySingleLine(choice.label)),
				action: choice,
			})),
			index: 0,
		};
	}

	/** Run the field or choice `action` of `account`: open its choices or input, refuse it, or apply it. */
	#activate(
		account: AccountManagerAccount,
		action: AccountManagerAction & { choices?: AccountManagerAction[] },
	): void {
		if (action.readOnly) {
			this.#notice = { tone: "warning", text: `${action.label}: ${action.readOnly}` };
			this.#strip = null;
			this.#frame.chipRanges = [];
			return;
		}
		if (action.choices) {
			this.#openChoiceStrip(account, action as AccountManagerField);
			return;
		}
		if (action.input) {
			const input = new Input();
			input.setValue(action.input.initial);
			this.#strip = { kind: "input", accountId: account.id, action, input };
			return;
		}
		void this.#apply(account.id, action, action.on === undefined ? undefined : action.on ? "off" : "on");
	}

	async #apply(accountId: string, action: AccountManagerAction, value?: string): Promise<void> {
		this.#strip = null;
		this.#frame.chipRanges = [];
		this.#busy = true;
		try {
			const result = await this.#deps.apply(accountId, action.id, value, action.expect);
			this.#notice = result.error
				? { tone: "error", text: result.error }
				: result.warning
					? { tone: "warning", text: [result.message, result.warning].filter(Boolean).join(" ") }
					: result.message
						? { tone: "success", text: result.message }
						: null;
		} catch (error) {
			this.#notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
		} finally {
			this.#busy = false;
		}
		if (this.#closed) return;
		this.#reload();
		this.#requestRender();
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

	#activateStripChip(): void {
		const strip = this.#strip;
		if (strip?.kind !== "chips") return;
		const chip = strip.chips[strip.index];
		const account = this.#account(strip.accountId);
		if (chip && account) this.#activate(account, chip.action);
	}

	/** Esc on a strip: a choice strip or input steps back to the field strip, the field strip closes. */
	#stripBack(strip: StripState): void {
		const account = this.#account(strip.accountId);
		if (account && (strip.kind === "input" || strip.field)) {
			this.#openFieldStrip(account);
			return;
		}
		this.#strip = null;
		this.#frame.chipRanges = [];
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
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			this.#requestRender();
			return;
		}
		const strip = this.#strip;
		if (strip) {
			if (matchesSelectCancel(data)) {
				this.#stripBack(strip);
			} else if (strip.kind === "input") {
				if (isEnter(data)) void this.#apply(strip.accountId, strip.action, strip.input.getValue().trim());
				else strip.input.handleInput(data);
			} else if (!moveStripSelection(strip, data) && isEnter(data)) {
				this.#activateStripChip();
			}
			this.#requestRender();
			return;
		}
		if (matchesSelectCancel(data)) {
			this.#close();
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
			else if (account) this.#openFieldStrip(account);
		} else if (this.#focus === "list") {
			const account = this.#selected();
			const field = account?.fields.find(
				candidate => candidate.key !== undefined && matchesKey(data, candidate.key),
			);
			if (account && field) this.#activate(account, field);
		}
		this.#requestRender();
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
		const { footerColumn, bodyHeight, contentLine, overSidebar, overBody, bodyLine } = this.#frame.locate(
			event.row,
			event.col,
		);
		const strip = this.#strip;
		if (footerColumn !== undefined && strip?.kind === "chips") {
			if (event.leftClick && this.#frame.selectChipAt(strip, footerColumn)) this.#activateStripChip();
			return true;
		}
		if (strip) return true;
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
			const index = bodyLine - this.#listRowStart + this.#listScroll;
			const account = this.#rows[index];
			if (account) {
				if (index === this.#rowIndex) this.#openFieldStrip(account);
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
		const scope = entry.kind === "provider" ? `${entry.label} accounts` : "All accounts";
		return { text: `${scope} · ${this.#rows.length}`, tone: "muted" };
	}

	#accountTitle(account: AccountManagerAccount): string {
		return sanitizeDisplaySingleLine(account.name ?? "(unnamed)");
	}

	#renderBody(width: number, rows: number): string[] {
		const status = this.#statusText();
		const lines: string[] = [truncateToWidth(theme.fg(status.tone, ` ${status.text}`), width), ""];
		this.#listRowStart = lines.length;
		const selected = this.#selected();
		const detailRows = selected ? Math.min(selected.details.length + 2, Math.max(0, rows - 6)) : 2;
		const visibleRows = Math.max(1, rows - lines.length - detailRows);
		if (this.#rowIndex < this.#listScroll) this.#listScroll = this.#rowIndex;
		else if (this.#rowIndex >= this.#listScroll + visibleRows) this.#listScroll = this.#rowIndex - visibleRows + 1;
		let nameWidth = 0;
		for (const account of this.#rows) nameWidth = Math.max(nameWidth, visibleWidth(this.#accountTitle(account)));
		const multiProvider = this.#activeEntry().kind === "all";
		for (let i = this.#listScroll; i < Math.min(this.#rows.length, this.#listScroll + visibleRows); i++) {
			const account = this.#rows[i]!;
			const active = i === this.#rowIndex;
			const cursor = active && this.#focus === "list" ? theme.fg("accent", theme.nav.cursor) : " ";
			const name = this.#accountTitle(account).padEnd(nameWidth);
			const provider = multiProvider ? `${theme.fg("dim", sanitizeDisplaySingleLine(account.provider))}  ` : "";
			let line = ` ${cursor} ${active ? theme.bold(theme.fg("accent", name)) : name}  ${provider}${sanitizeDisplaySingleLine(account.identity)}`;
			const badges = theme.fg("dim", sanitizeDisplaySingleLine(account.badges.join(" · ")));
			const lineWidth = visibleWidth(line);
			const badgeWidth = visibleWidth(badges);
			if (badgeWidth > 0 && lineWidth + badgeWidth + 2 <= width) {
				line = `${line}${" ".repeat(width - lineWidth - badgeWidth - 1)}${badges}`;
			}
			lines.push(truncateToWidth(line, width));
		}
		if (this.#rows.length === 0) lines.push(theme.fg("dim", " No stored accounts. Log in with /login."));
		while (lines.length < rows - detailRows) lines.push("");
		lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
		if (selected) {
			lines.push(
				truncateToWidth(
					` ${theme.bold(theme.fg("accent", this.#accountTitle(selected)))}  ${theme.fg("dim", sanitizeDisplaySingleLine(`${selected.provider} · ${selected.identity}`))}`,
					width,
				),
			);
			let labelWidth = 0;
			for (const detail of selected.details) labelWidth = Math.max(labelWidth, visibleWidth(detail.label));
			for (const detail of selected.details) {
				const value = sanitizeDisplaySingleLine(detail.value);
				lines.push(
					truncateToWidth(
						` ${theme.fg("muted", detail.label.padEnd(labelWidth))}  ${detail.tone ? theme.fg(detail.tone, value) : value}`,
						width,
					),
				);
			}
		} else {
			lines.push(theme.fg("dim", " Select an account to inspect"));
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#footerHint(): string {
		const enter = formatKeyHint("enter");
		const cancel = editorKey("tui.select.cancel");
		const strip = this.#strip;
		if (strip?.kind === "input") return `${strip.action.input?.hint ?? ""} · ${enter} apply · ${cancel} back`;
		if (strip) {
			return `${formatKeyHints(["left", "right"])} choose · ${enter} ${strip.field ? "apply" : "open"} · ${cancel} back`;
		}
		const upDown = editorKeys("tui.select.up", "tui.select.down");
		if (this.#focus === "scope")
			return `${upDown} providers · ${formatKeyHints(["right", "enter"])} accounts · ${cancel} close`;
		const shortcuts = (this.#selected()?.fields ?? [])
			.filter(field => field.key)
			.map(field => `${field.key} ${field.label}`)
			.join(" · ");
		return `${enter} edit · ${shortcuts}${shortcuts ? " · " : ""}${upDown} rows · ${formatKeyHint("ctrl+r")} reload · ${cancel} close`;
	}

	#renderFooter(width: number): string {
		const strip = this.#strip;
		return this.#frame.renderFooter(
			width,
			this.#footerHint(),
			strip ? () => this.#renderStrip(width, strip) : undefined,
		);
	}

	#stripPrefix(strip: StripState): string {
		const account = this.#account(strip.accountId);
		const name = account ? this.#accountTitle(account) : "";
		if (strip.kind === "input") return `${name} · ${strip.action.label}:`;
		return strip.field ? `${name} · ${strip.field.label} →` : `${name} →`;
	}

	#renderStrip(width: number, strip: StripState): string {
		const prefix = this.#stripPrefix(strip);
		if (strip.kind === "input") {
			const inputWidth = Math.max(8, Math.min(48, width - visibleWidth(prefix) - 4));
			return truncateToWidth(`${theme.fg("accent", prefix)} ${strip.input.render(inputWidth)[0] ?? ""}`, width);
		}
		return this.#frame.renderChips(width, `${theme.fg("accent", prefix)} `, strip);
	}

	render(width: number): readonly string[] {
		return this.#frame.render(width, this.#terminalRows(), this.#entries, this.#renderFooter(width - 4));
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Native (TSP) description
	// ═══════════════════════════════════════════════════════════════════════

	describe(_cx: DescribeContext): NativeNode {
		const cached = this.#nativeCache;
		if (cached?.version === this.#nativeVersion) return cached.node;
		const footer: NativeChild[] = [];
		const strip = this.#describeStrip();
		if (strip) footer.push(strip);
		footer.push(hintsRow(this.#footerHints()));
		const described = describeHubFrame(
			"omp.hub.accounts",
			"Accounts",
			describeHubSidebar(this.#entries, this.#activeEntryId, this.#sidebarStyle, "providers"),
			this.#describeBody(),
			node("col", { gap: "xs" }, footer, "footer"),
		);
		this.#nativeCache = { version: this.#nativeVersion, node: described };
		return described;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if ((event.type !== "select" && event.type !== "activate") || this.#busy) return;
		const target = event.key.slice(event.key.lastIndexOf("/") + 1);
		const activate = event.type === "activate";
		if (target === "strip") {
			const strip = this.#strip;
			const index = Number(event.item);
			if (strip?.kind !== "chips" || !Number.isInteger(index) || !strip.chips[index]) return;
			strip.index = index;
			if (activate) this.#activateStripChip();
		} else if (target === "accounts") {
			if (this.#strip) return;
			const index = this.#rows.findIndex(account => accountItemId(account) === event.item);
			if (index < 0) return;
			this.#focus = "list";
			this.#rowIndex = index;
			if (activate) this.#openFieldStrip(this.#rows[index]!);
		} else if (target === "providers") {
			if (this.#strip) return;
			const entry = this.#entries.find(candidate => candidate.id === event.item);
			if (!entry || entry.kind === "separator") return;
			this.#selectEntry(entry);
			this.#focus = activate ? "list" : "scope";
		} else {
			return;
		}
		this.#requestRender();
	}

	#describeBody(): NativeNode {
		const status = this.#statusText();
		const selected = this.#selected();
		const multiProvider = this.#activeEntry().kind === "all";
		const items = this.#rows.map(account =>
			node(
				"item",
				{
					label: [span(account.name ?? "(unnamed)", account.name ? "strong" : "dim")],
					detail: [span(multiProvider ? `${account.provider} · ${account.identity}` : account.identity, "dim")],
					value: account.badges.length > 0 ? [span(account.badges.join(" · "), "dim")] : undefined,
				},
				undefined,
				accountItemId(account),
			),
		);
		const children: NativeChild[] = [
			node("text", { spans: [span(status.text, status.tone)], truncate: "end" }, undefined, "status"),
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
		children.push(
			selected
				? node(
						"section",
						{
							head: [span(selected.name ?? "(unnamed)", "accent strong"), span(`  ${selected.identity}`, "dim")],
						},
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
					)
				: node("section", {}, [text([span("Select an account to inspect", "dim")])], "detail"),
		);
		return node("col", { gap: "sm", grow: 1 }, children, "body");
	}

	#describeStrip(): NativeNode | undefined {
		const strip = this.#strip;
		if (!strip) return undefined;
		const prefix = text([span(this.#stripPrefix(strip), "accent")]);
		if (strip.kind === "input") return row([prefix, col([strip.input], { grow: 1 })], { gap: "sm", align: "center" });
		return row(
			[
				prefix,
				node(
					"tabs",
					{
						items: strip.chips.map((chip, index) => ({ id: String(index), label: this.#chipSpans(chip) })),
						active: String(strip.index),
						actions: { click: "activate" },
					},
					undefined,
					"strip",
				),
			],
			{ gap: "sm", align: "center" },
		);
	}

	#chipSpans(chip: StripChip): TspSpan[] {
		const action = chip.action;
		if (action.readOnly) return [span(chip.label, "dim")];
		if (action.on) return [span(`${theme.status.enabled} ${chip.label}`, "accent")];
		return [span(chip.label, "value" in action ? "accent" : "muted")];
	}

	#footerHints(): (NativeHint | undefined)[] {
		const cancel = (label: string) => actionHint("tui.select.cancel", label);
		const strip = this.#strip;
		if (strip?.kind === "input")
			return [{ keys: ["enter"], label: strip.action.input?.hint ?? "apply" }, cancel("back")];
		if (strip) {
			return [
				{ keys: ["left", "right"], label: "choose" },
				{ keys: ["enter"], label: strip.field ? "apply" : "open" },
				cancel("back"),
			];
		}
		const upDown = actionHint(["tui.select.up", "tui.select.down"], this.#focus === "scope" ? "providers" : "rows");
		if (this.#focus === "scope") return [upDown, { keys: ["right", "enter"], label: "accounts" }, cancel("close")];
		const shortcuts: NativeHint[] = (this.#selected()?.fields ?? []).flatMap(field =>
			field.key ? [{ keys: [field.key], label: field.label }] : [],
		);
		return [
			{ keys: ["enter"], label: "edit" },
			...shortcuts,
			upDown,
			{ keys: ["ctrl+r"], label: "reload" },
			cancel("close"),
		];
	}
}
