---
type: 'regex'
target: { source: 'file', path: '.pe/calls.log' }
pattern: 'phase-outcome\.sh demo 2 (?:needs-human|blocked)'
match: 'not_contains'
---
