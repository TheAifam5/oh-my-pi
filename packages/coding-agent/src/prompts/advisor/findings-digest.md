{{#if entries.length}}
<open-findings>
Open advisor findings. Before reporting, check this list: a report about one of them MUST name it with `relatesTo` + `relation` instead of opening a new finding.
{{#each entries}}
- {{this}}
{{/each}}
{{#if more}}
- and {{more}} more
{{/if}}
</open-findings>
{{/if}}
{{#if resolved.length}}
<agent-resolutions>
Recently resolved by the main agent, newest first. Consider the recorded reason before reporting the same defect again.
{{#each resolved}}
- {{this}}
{{/each}}
</agent-resolutions>
{{/if}}
