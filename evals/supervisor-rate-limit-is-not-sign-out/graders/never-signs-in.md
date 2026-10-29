---
type: 'regex'
target: 'trace'
pattern: '"command":"(?:[^"\n]*(?:&&|;)\s*)?claude (?:auth )?login'
match: 'not_contains'
---
