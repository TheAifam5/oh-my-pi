import type { TspPrefsControl, TspPrefsProps, TspPrefsRow } from "@oh-my-pi/pi-wire";
import { Input } from "../components/input";
import { SettingsList, type SettingItem } from "../components/settings-list";
import { SelectList } from "../components/select-list";
import { matchesKey } from "../keys";
import { matchesSelectCancel } from "../keybinding-matchers";
import { node } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import type { Component } from "../tui";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme";
import { sanitizeDisplaySingleLine } from "./extensions/display-text";
import { truncateToWidth, wrapTextWithAnsi } from "../utils";

export type HubPrefsValue = boolean | number | string | readonly string[] | null;

export interface HubPrefsField extends TspPrefsRow {
	/** Numeric draft seed; an empty string represents an inherited value. */
	initial?: string;
	apply: (value: HubPrefsValue) => string | undefined | Promise<string | undefined>;
}

export class HubPrefs implements Component {
	#list: SettingsList;
	#fields: () => HubPrefsField[];
	#title: string;
	#close: () => void;
	#render: () => void;
	#errors = new Map<string, string>();
	#input: { id: string; input: Input } | undefined;
	#multi: { id: string; values: string[]; list: SettingsList } | undefined;
	#choice: { id: string; list: SelectList } | undefined;
	#busy = false;
	#fallbackList: Component = {
		render: width => (this.#choice?.list ?? this.#multi?.list ?? this.#list).render(width),
		describe: cx => (this.#choice?.list ?? this.#multi?.list ?? this.#list).describe(cx),
		handleNativeEvent: event => {
			if (this.#busy) return;
			if (this.#choice) this.#choice.list.handleNativeEvent(event);
			else if (this.#multi) this.#multi.list.handleNativeEvent(event);
			else if (event.type === "select" || event.type === "activate") {
				const wasSelected = this.#list.getSelectedItem()?.id === event.item;
				this.focus(event.item);
				if (event.type === "activate" || wasSelected) this.#activate(event.item);
			}
			this.#render();
		},
	};

	constructor(title: string, fields: () => HubPrefsField[], close: () => void, render: () => void) {
		this.#title = sanitizeDisplaySingleLine(title);
		this.#fields = fields;
		this.#close = close;
		this.#render = render;
		this.#list = new SettingsList([], 12, getSettingsListTheme(), () => {}, close, { typeToSearch: false });
		this.#refresh();
	}

	#refresh(): void {
		const items: SettingItem[] = this.#fields().map(field => ({
			id: field.id,
			label: sanitizeDisplaySingleLine(field.label),
			currentValue: field.initial === "" ? "inherit" : sanitizeDisplaySingleLine(this.#shown(field.control)),
			description: sanitizeDisplaySingleLine(field.disabled ?? field.hint ?? ""),
			warning: this.#errors.get(field.id),
		}));
		this.#list.setItems(items);
	}

	#shown(control: TspPrefsControl): string {
		switch (control.k) {
			case "switch":
				return control.on ? "on" : "off";
			case "choice":
				return control.options.find(option => option.value === control.value)?.label ?? control.value;
			case "number":
				return `${control.value}${control.unit ?? ""}`;
			case "text":
				return sanitizeDisplaySingleLine(control.value);
			case "multi":
				return control.values.join(" → ");
			case "action":
				return control.label;
			case "keys":
				return "";
		}
	}

	focus(id: string): void {
		this.#list.selectItem(id);
	}
	startEditing(id: string): void {
		this.focus(id);
		this.#activate(id);
	}

	#activate(id: string): void {
		const field = this.#fields().find(field => field.id === id);
		if (!field || field.disabled || this.#busy) return;
		this.#choice = undefined;
		this.#multi = undefined;
		this.#input = undefined;
		const control = field.control;
		if (control.k === "switch") void this.#apply(id, !control.on);
		else if (control.k === "choice") {
			if (
				control.style === "menu" ||
				(control.style !== "segmented" &&
					(control.options.length < 2 ||
						control.options.length > 4 ||
						control.options.reduce((length, option) => length + option.label.length, 0) > 28))
			) {
				const list = new SelectList(
					control.options.map(option => ({
						value: option.value,
						label: sanitizeDisplaySingleLine(option.label),
						description: sanitizeDisplaySingleLine(option.detail ?? ""),
					})),
					12,
					getSelectListTheme(),
					{ search: "never" },
				);
				list.setSelectedValue(control.value);
				list.onSelect = item => {
					if (this.#choice?.id === id && !this.#busy) void this.#apply(id, item.value);
				};
				this.#choice = { id, list };
				return;
			}
			const index = control.options.findIndex(option => option.value === control.value);
			const next = control.options[(index + 1) % control.options.length];
			if (next) void this.#apply(id, next.value);
		} else if (control.k === "action") void this.#apply(id, null);
		else if (control.k === "text" || control.k === "number") {
			const input = new Input();
			input.setValue(sanitizeDisplaySingleLine(field.initial ?? String(control.value)));
			this.#input = { id, input };
		} else if (control.k === "multi") {
			this.#openMulti(id, control);
		}
	}

	#openMulti(id: string, control: Extract<TspPrefsControl, { k: "multi" }>): void {
		const values = [...control.values];
		const items = control.options.map(option => ({
			id: option.value,
			label: sanitizeDisplaySingleLine(option.label),
			currentValue: values.includes(option.value) ? "on" : "off",
			values: ["off", "on"],
		}));
		const list = new SettingsList(
			items,
			Math.max(1, Math.min(12, items.length)),
			getSettingsListTheme(),
			(value, selected) => {
				const index = values.indexOf(value);
				if (selected === "on" && index < 0) values.push(value);
				else if (selected === "off" && index >= 0) values.splice(index, 1);
			},
			() => {
				this.#multi = undefined;
			},
			{
				typeToSearch: false,
				hint: control.ordered
					? "Space toggles · [ / ] reorder selected · Enter saves · Escape cancels"
					: "Space toggles · Enter saves · Escape cancels",
			},
		);
		this.#multi = { id, values, list };
	}

	#validate(control: TspPrefsControl, value: HubPrefsValue): string | undefined {
		if (control.k === "number" && value !== "" && value !== null) {
			if (typeof value === "string" && value.trim() === "") return "Enter a finite number";
			const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
			if (!Number.isFinite(number)) return "Enter a finite number";
			if (control.min !== undefined && number < control.min) return `Must be at least ${control.min}`;
			if (control.max !== undefined && number > control.max) return `Must be at most ${control.max}`;
		} else if (control.k === "switch" && typeof value !== "boolean") return "Choose on or off";
		else if (control.k === "text" && typeof value !== "string") return "Enter text";
		else if (control.k === "choice" && !control.options.some(option => option.value === value))
			return "Choose a listed option";
		else if (
			control.k === "multi" &&
			(!Array.isArray(value) ||
				new Set(value).size !== value.length ||
				value.some(entry => !control.options.some(option => option.value === entry)))
		)
			return "Choose distinct listed options";
		return undefined;
	}

	async #apply(id: string, value: HubPrefsValue): Promise<void> {
		const field = this.#fields().find(field => field.id === id);
		if (!field || field.disabled || this.#busy) return;
		const validation = this.#validate(field.control, value);
		if (validation) {
			this.#errors.set(id, validation);
			this.#refresh();
			this.#render();
			return;
		}
		this.#busy = true;
		let error: string | undefined;
		try {
			const result =
				field.control.k === "number" && field.initial === "" && value === "" ? undefined : field.apply(value);
			error = result instanceof Promise ? await result : result;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
		this.#busy = false;
		if (error !== undefined) this.#errors.set(id, sanitizeDisplaySingleLine(error));
		else {
			this.#errors.delete(id);
			this.#input = undefined;
			this.#multi = undefined;
			this.#choice = undefined;
		}
		this.#refresh();
		this.#render();
	}

	handleInput(data: string): void {
		if (this.#busy) return;
		if (this.#choice) {
			const choice = this.#choice;
			if (matchesSelectCancel(data)) this.#choice = undefined;
			else if (matchesKey(data, "enter") || data === "\n") {
				const value = choice.list.getSelectedItem()?.value;
				if (value !== undefined) void this.#apply(choice.id, value);
			} else choice.list.handleInput(data);
		} else if (this.#input) {
			if (matchesSelectCancel(data)) this.#input = undefined;
			else if (matchesKey(data, "enter") || data === "\n") {
				void this.#apply(this.#input.id, this.#input.input.getValue());
			} else this.#input.input.handleInput(data);
		} else if (this.#multi) {
			const multi = this.#multi;
			if (matchesKey(data, "enter") || data === "\n") void this.#apply(multi.id, multi.values);
			else if (data === "[" || data === "]") {
				const field = this.#fields().find(field => field.id === multi.id);
				if (field?.control.k === "multi" && field.control.ordered) {
					const id = multi.list.getSelectedItem()?.id;
					const index = id === undefined ? -1 : multi.values.indexOf(id);
					const next = index + (data === "[" ? -1 : 1);
					if (index >= 0 && next >= 0 && next < multi.values.length) {
						const value = multi.values.splice(index, 1)[0]!;
						multi.values.splice(next, 0, value);
					}
				}
			} else multi.list.handleInput(data);
		} else if (matchesKey(data, "enter") || data === " " || data === "\n") {
			const id = this.#list.getSelectedItem()?.id;
			if (id) this.#activate(id);
		} else if (
			this.#fields().every(field => field.control.k === "action") &&
			(matchesKey(data, "left") || matchesKey(data, "right"))
		) {
			this.#list.handleInput(matchesKey(data, "left") ? "\x1b[A" : "\x1b[B");
		} else this.#list.handleInput(data);
		this.#render();
	}

	render(width: number): string[] {
		this.#list.setMaxVisible(Math.max(1, Math.min(12, this.#fields().length)));
		const rows = [
			theme.bold(truncateToWidth(this.#title, width)),
			"",
			...(this.#choice?.list ?? this.#multi?.list ?? this.#list).render(width),
		];
		if (this.#multi)
			rows.push(...wrapTextWithAnsi(sanitizeDisplaySingleLine(`Order: ${this.#multi.values.join(" → ")}`), width));
		if (this.#input) {
			rows.push("", ...this.#input.input.render(width));
			const error = this.#errors.get(this.#input.id);
			if (error) rows.push(...wrapTextWithAnsi(theme.fg("warning", error), width));
		}
		const stagedId = this.#choice?.id ?? this.#multi?.id;
		if (stagedId) {
			const error = this.#errors.get(stagedId);
			if (error) rows.push(...wrapTextWithAnsi(theme.fg("warning", error), width));
		}
		return rows;
	}

	describe(cx: DescribeContext): NativeNode {
		if (!cx.supports("prefs"))
			return node("col", {}, [this.#fallbackList, ...(this.#input ? [this.#input.input] : [])]);
		const props: TspPrefsProps = {
			title: this.#title,
			pages: [{ id: "object", label: this.#title }],
			page: "object",
			sections: [
				{
					id: "fields",
					title: "Settings",
					rows: this.#fields().map(({ apply: _apply, initial, ...field }) => ({
						...field,
						label: sanitizeDisplaySingleLine(field.label),
						hint: sanitizeDisplaySingleLine(
							[initial === "" ? "Inherit (unset)" : "", field.hint].filter(Boolean).join(" · "),
						),
						disabled: this.#busy
							? "Saving…"
							: field.disabled
								? sanitizeDisplaySingleLine(field.disabled)
								: undefined,
						warning: this.#errors.get(field.id),
						control: this.#displayControl(
							field.control.k === "multi" && this.#multi?.id === field.id
								? { ...field.control, values: this.#multi.values }
								: field.control,
						),
					})),
				},
			],
			focus: this.#list.getSelectedItem()?.id,
			editing: this.#input
				? { row: this.#input.id, draft: this.#input.input.getValue(), cursor: this.#input.input.getCursor() }
				: this.#choice
					? { row: this.#choice.id, option: this.#choice.list.getSelectedItem()?.value }
					: this.#multi
						? { row: this.#multi.id, option: this.#multi.list.getSelectedItem()?.id }
						: null,
		};
		return node("prefs", props);
	}

	#displayControl(control: TspPrefsControl): TspPrefsControl {
		if (control.k === "choice" || control.k === "multi") {
			return {
				...control,
				options: control.options.map(option => ({
					...option,
					label: sanitizeDisplaySingleLine(option.label),
					...("detail" in option && typeof option.detail === "string"
						? { detail: sanitizeDisplaySingleLine(option.detail) }
						: {}),
				})),
			};
		}
		if (control.k === "text")
			return {
				...control,
				value: sanitizeDisplaySingleLine(control.value),
				placeholder: control.placeholder ? sanitizeDisplaySingleLine(control.placeholder) : undefined,
			};
		if (control.k === "action") return { ...control, label: sanitizeDisplaySingleLine(control.label) };
		if (control.k === "number")
			return { ...control, unit: control.unit ? sanitizeDisplaySingleLine(control.unit) : undefined };
		return control;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#busy) return;
		if (event.type === "change") {
			this.focus(event.item);
			const field = this.#fields().find(field => field.id === event.item);
			if (!field || field.disabled) return;
			const control = field.control;
			if (control.k === "choice" && this.#choice?.id === event.item && typeof event.value === "string")
				this.#choice.list.setSelectedValue(event.value);
			if (control.k === "multi" && this.#multi?.id === event.item && Array.isArray(event.value)) {
				if (!this.#validate(control, event.value)) {
					this.#multi.values.splice(0, this.#multi.values.length, ...event.value);
					for (const option of control.options) {
						this.#multi.list.updateValue(option.value, this.#multi.values.includes(option.value) ? "on" : "off");
					}
				}
			}
			if (typeof event.value === "string" && (control?.k === "text" || control?.k === "number")) {
				const current = this.#input;
				if (current?.id !== event.item) {
					const input = new Input();
					input.setValue(event.value);
					this.#input = { id: event.item, input };
				} else if (current.input.getValue() !== event.value) current.input.setValue(event.value);
			}
			void this.#apply(event.item, event.value);
		} else if (event.type === "edit" || event.type === "undo") this.#input?.input.handleNativeEvent(event);
		else if (event.type === "select") {
			if ("item" in event && typeof event.item === "string") {
				const choice = this.#choice;
				if (choice && event.item.startsWith(`${choice.id}=`)) {
					choice.list.setSelectedValue(event.item.slice(choice.id.length + 1));
				} else this.focus(event.item);
			}
		} else if (event.type === "activate") {
			this.focus(event.item);
			this.#activate(event.item);
		} else if (event.type === "action") {
			if (event.act === "close") {
				if (this.#input || this.#choice || this.#multi) {
					this.#input = undefined;
					this.#choice = undefined;
					this.#multi = undefined;
				} else if (!event.value) this.#close();
			} else if (event.act === "edit" && event.value) {
				this.focus(event.value);
				this.#activate(event.value);
			} else {
				const field = this.#fields().find(field => field.control.k === "action" && field.control.act === event.act);
				if (field) void this.#apply(field.id, null);
			}
		}
		this.#render();
	}
}
