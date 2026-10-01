/**
 * The grid — one column array, three renderings, and the view an operator
 * makes of it. NOT part of the preloaded `@/components/ui` barrel: that
 * barrel is one modulepreloaded chunk every visitor downloads before the first
 * frame, and a table is on the pages that draw one, never on the first paint.
 *
 * `layout.ts` is the arithmetic (also what the hand-rolled tables import),
 * `data-table.tsx` the table, `card-list.tsx` its phone rendering, `toolbar.tsx`
 * its controls. `engine.ts` is deliberately NOT re-exported here: it is the
 * row model TanStack Table provides, loaded on demand by `data-table.tsx`, and
 * a static re-export would put the library back on every table's path.
 */

export { DataTable, loadEngine, type BulkVerb, type DataTableProps, type TableView } from './data-table';
export { CardList } from './card-list';
export {
  NO_VALUE,
  VIRTUAL_FROM,
  canHide,
  planColumns,
  railOffsets,
  trackOf,
  useTableFit,
  type Column,
  type FilterKind,
  type FilterValue,
} from './layout';
