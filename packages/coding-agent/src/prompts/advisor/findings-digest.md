<open-findings>
Open advisor findings. Relate a report to one with `relatesTo` + `relation`; do not re-raise them unchanged.
{{#each entries}}
- {{this}}
{{/each}}
{{#if more}}
- and {{more}} more
{{/if}}
</open-findings>
