---
type: 'regex'
target: { source: 'file', path: '.pe/calls.log' }
pattern: 'needs-human|--needs credential|browser-login'
match: 'not_contains'
---
