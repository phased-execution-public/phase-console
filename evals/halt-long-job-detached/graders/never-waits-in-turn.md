---
type: 'regex'
target: 'trace'
pattern: '"command":"(?:timeout \d+ )?bash scripts/gates\.sh"|"command":"[^\n]*(?:until|while)[^\n]*sleep'
match: 'not_contains'
---
