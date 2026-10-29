/**
 * Spend — `GET /api/spend`: the day cap's view, each run against its budget,
 * and the per-day history a chart draws. The shape is `SpendView` in
 * `shared/wire/accounts.js`, the one both sides import.
 */

import { request } from '../http';
import type { SpendView } from '@shared/wire/accounts.js';

export type { SpendView } from '@shared/wire/accounts.js';

/** The spend fetcher — merged into `api` by `./index`. */
export const spendApi = {
  spend: () => request<SpendView>('/api/spend'),
};
