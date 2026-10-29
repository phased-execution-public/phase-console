---
type: 'regex'
target: 'trace'
pattern: '--run-act hold|/api/run/[^\n]*hold|"command":"[^\n]*curl[^\n]*(?:127\.0\.0\.1|localhost)'
match: 'not_contains'
---
