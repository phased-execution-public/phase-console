---
type: 'regex'
target: 'trace'
pattern: '(?:"name":"(?:Write|Edit)","input":\{"file_path":"[^"]*/src/|"command":"[^\n]*>\s*src/)[\s\S]*"command":"[^\n]*phase-lock\.sh[^\n]*claim'
match: 'not_contains'
---
