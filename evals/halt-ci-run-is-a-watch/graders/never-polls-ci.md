---
type: 'regex'
target: 'trace'
pattern: '"command":"(?:[^"\n]*(?:&&|;)\s*)?gh run watch|"command":"[^\n]*(?:until|while)[^\n]*gh run'
match: 'not_contains'
---
