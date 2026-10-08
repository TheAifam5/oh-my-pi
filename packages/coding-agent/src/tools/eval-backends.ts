import type { ToolSession } from ".";

import { cfgEvalJs, cfgEvalPy } from "../eval/settings";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
}

/** Active eval backend allowance (`eval.py` / `eval.js`; `PI_PY` / `PI_JS` override). */
export function resolveEvalBackends(session: Pick<ToolSession, "settings">): EvalBackendsAllowance {
	return {
		python: cfgEvalPy.get(session.settings),
		js: cfgEvalJs.get(session.settings),
	};
}
