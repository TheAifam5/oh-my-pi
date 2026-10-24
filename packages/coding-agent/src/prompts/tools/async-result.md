<system-notice>
{{#if multiple}}{{jobs.length}} background jobs have finished. Resume your work using the results below.

{{else}}Background job {{jobs.[0].jobId}} {{#if jobs.[0].failed}}failed{{else}}{{#if jobs.[0].cancelled}}was cancelled{{else}}has completed{{/if}}{{/if}}. Resume your work using the result below.
{{/if}}{{#each jobs}}{{#if @root.multiple}}── Job {{this.jobId}}{{#if this.label}} ({{this.label}}){{/if}}{{#if this.failed}} — failed{{/if}}{{#if this.cancelled}} — cancelled{{/if}} ──
{{/if}}{{this.result}}{{#if this.schemaStatus}}

Structured output: {{this.schemaStatusLabel}}{{#if this.schemaError}}: {{this.schemaError}}{{/if}}{{#if this.hasStructuredData}}; full payload at agent://{{this.agentUrlId}}, fields via agent://{{this.agentUrlId}}/<field>[/<index>/…]{{/if}}{{#unless this.schemaValid}}{{#if this.structuredJson}}; preview:
```json
{{this.structuredJson}}
```{{/if}}{{/unless}}{{/if}}{{#unless @last}}
{{/unless}}{{/each}}
</system-notice>