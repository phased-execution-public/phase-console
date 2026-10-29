---
type: 'regex'
target: 'trace'
pattern: '"command":"[^\n]*git (?:stash|reset|checkout --|checkout \.|restore|clean)'
match: 'not_contains'
---
