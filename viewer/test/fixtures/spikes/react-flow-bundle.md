# Probe — what a React Flow + d3-dag repository map actually costs to ship

node: v24.13.1
npm: 11.19.0
date: 2026-09-18
verdict: affordable-lazy
cost_usd: 0 (one scratch `npm i` and one esbuild bundle)
settles: `many-plans-one-repo` phase 1 arm RF-1 — whether phase 14 may draw `#/repo/landscape` on these two

**Why this exists.** Phase 14 draws the repository map on React Flow with a d3-dag layout, as a lazily
loaded Pro chunk. Two things could have killed that choice late: a licence the free/Pro split cannot carry,
and a chunk big enough to be felt on a page an operator opens often. Neither does.

| arm | what | verdict |
|---|---|---|
| `RF-1` | installed size, gzipped chunk size and licences of `@xyflow/react` + `d3-dag` | affordable-lazy |

## Licences — both MIT

| package | version | licence | installed |
|---|---|---|---|
| `@xyflow/react` | 12.11.6 | MIT | 2,860 KiB |
| `d3-dag` | 1.2.2 | MIT | 680 KiB |

MIT is what the plan assumed and what the split needs: the map is a Pro surface, and neither licence
constrains shipping it in a paid build or omitting it from the free one. `npm i` reported **0
vulnerabilities**. (Total `node_modules` for the scratch project was 19,592 KiB, but that includes `react`
and `react-dom`, which the console already ships.)

## The chunk

Bundled with `esbuild@0.25.0 --bundle --minify --format=esm`, `react`, `react-dom` and `react/jsx-runtime`
**external** — the shape a lazily imported Pro route actually emits, since the app already carries React:

| output | raw | gzipped |
|---|---|---|
| `chunk.js` | 295,517 B | **97,000 B** |
| `chunk.css` | 15,869 B | 2,666 B |
| combined | 311,386 B | **99,678 B (≈97 KiB)** |

The entry was not a toy: it imports `ReactFlow`, `Background`, `Controls`, `MiniMap`, `Handle`, `Position`
and the stylesheet from `@xyflow/react`, and `graphStratify`, `sugiyama`, `decrossOpt`, `decrossTwoLayer`,
`coordSimplex` and `layeringLongestPath` from `d3-dag` — i.e. both the renderer and a full sugiyama layout
pipeline, which is what a repository map uses.

**Reading the verdict.** Under 100 KiB gzipped, behind a lazy import, on a route nobody loads until they ask
for the map. That is affordable. It is *not* affordable unlazily: 97 KiB on every page load would be a
visible regression on a console whose other routes are small, so phase 14's "lazy chunk" is a requirement
rather than a nicety, and the dist guard should assert the map does not land in the entry chunk.

## A naming trap phase 14 will hit

`d3-dag` **v1** renamed the v0 API. `dagStratify`, `dagConnect` and `dagHierarchy` are gone; the current
names are `graphStratify`, `graphConnect`, `graphHierarchy`, and layouts compose as
`sugiyama().layering(…).decross(…).coord(…)`. The full export list this version offers:

```
zherebko, unsugify, twolayerOpt, twolayerGreedy, twolayerAgg, tweakSugiyama, sugiyama, sugifyLayer,
sugifyCompact, sugiNodeLength, layeringTopological, layeringSimplex, layeringLongestPath, layerSeparation,
graphStratify, graphJson, graphHierarchy, graphConnect, graph, decrossTwoLayer, decrossOpt, decrossDfs,
coordTopological, coordSimplex, coordQuad, coordGreedy, coordCenter
```

Most tutorials and model recall predate the rename; an import of `dagStratify` fails at bundle time, not at
runtime, so it will be caught — but it will be caught repeatedly if nobody writes it down. This is that.

## What this fixture does not establish

Runtime cost — frame rate on a large graph, layout time for a hundred-node dag, memory — was not measured;
only what it costs to *load*. `decrossOpt` is exponential by design and phase 14 should reach for
`decrossTwoLayer` on anything but small graphs, but that is a judgement from its documentation, not a
measurement here.
