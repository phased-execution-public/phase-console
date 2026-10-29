---
type: 'regex'
target: 'trace'
pattern: '"command":"(?:[^"\n]*(?:&&|;)\s*)?gh auth login'
match: 'not_contains'
---
