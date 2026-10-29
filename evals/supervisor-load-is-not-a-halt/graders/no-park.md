---
type: 'regex'
target: { source: 'file', path: '.pe/calls.log' }
pattern: 'phase-outcome\.sh demo 2 (?:partial|blocked|needs-human)'
match: 'not_contains'
---
