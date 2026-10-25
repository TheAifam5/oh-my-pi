import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

export interface SegmentedOption<T extends string> {
	value: T;
	label: ReactNode;
	title?: string;
}

export interface SegmentedProps<T extends string> {
	options: readonly SegmentedOption<T>[];
	value: T;
	onChange: (value: T) => void;
	size?: "md" | "sm";
	"aria-label"?: string;
}

/** Single-selection filter with roving keyboard focus and a measured thumb. */
export function Segmented<T extends string>({
	options,
	value,
	onChange,
	size = "md",
	"aria-label": ariaLabel,
}: SegmentedProps<T>) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [thumb, setThumb] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

	useLayoutEffect(() => {
		const root = rootRef.current;
		const active = root?.querySelector<HTMLElement>('[data-active="true"]');
		if (!root || !active) {
			setThumb(null);
			return;
		}
		const measure = () =>
			setThumb({
				left: active.offsetLeft,
				top: active.offsetTop,
				width: active.offsetWidth,
				height: active.offsetHeight,
			});
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		observer.observe(active);
		return () => observer.disconnect();
	}, [value, options]);

	return (
		<div ref={rootRef} className="segmented" data-size={size} role="radiogroup" aria-label={ariaLabel}>
			{thumb && <span aria-hidden="true" className="segmented-thumb" style={thumb} />}
			{options.map((option, index) => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={option.value === value}
					tabIndex={
						option.value === value || (!options.some(item => item.value === value) && index === 0) ? 0 : -1
					}
					className="segmented-option"
					data-active={option.value === value}
					title={option.title}
					onClick={() => onChange(option.value)}
					onKeyDown={event => {
						let next: number;
						switch (event.key) {
							case "ArrowRight":
							case "ArrowDown":
								next = (index + 1) % options.length;
								break;
							case "ArrowLeft":
							case "ArrowUp":
								next = (index - 1 + options.length) % options.length;
								break;
							case "Home":
								next = 0;
								break;
							case "End":
								next = options.length - 1;
								break;
							default:
								return;
						}
						event.preventDefault();
						const selected = options[next];
						if (!selected) return;
						onChange(selected.value);
						rootRef.current?.querySelectorAll<HTMLButtonElement>('button[role="radio"]')[next]?.focus();
					}}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
