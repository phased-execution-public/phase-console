---
type: 'regex'
target: 'trace'
pattern: '"name":"(?:Write|Edit|Bash)","input":\{[^\n]*phase-02-[^\n]*START COPY|Continue the \\"demo\\" plan'
match: 'not_contains'
---
