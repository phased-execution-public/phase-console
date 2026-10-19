/**
 * Who pays for a run, in one line (one-pool phase 11): the account, its provider and the
 * model — "work · Claude · opus", "deepseek-main · DeepSeek · deepseek-v4-pro". The Runs row
 * and the run's header say it the same way, so a run on an API key reads as one at a glance.
 */

import type { AccountView } from '@/data/api';

/** The account's own words: its name, else its email, else its id; the machine login by that name. */
export function payerWho(
  id: string | null | undefined,
  accounts: readonly AccountView[] | undefined,
): string {
  const account = accounts?.find((candidate) => candidate.id === (id ?? 'default'));
  if (!id || id === 'default') return account?.email ? `machine login (${account.email})` : 'machine login';
  return account ? (account.name ?? account.email ?? account.id) : id;
}

/** Whose models the account runs: a Claude login's, or (Pro) an API key's provider. */
export function payerProvider(
  id: string | null | undefined,
  accounts: readonly AccountView[] | undefined,
): string {
  const said = {
    provider: 'Claude',
    account: accounts?.find((candidate) => candidate.id === (id ?? 'default')),
  };
  return said.provider;
}

/**
 * An API key's words wherever an account is offered (one-pool phase 11): "DeepSeek API key ·
 * cap reached" — its provider and its standing with the pool, as the status vocabulary says
 * it. Null for a login, and always in the free edition.
 */
export function apiKeyWords(account: AccountView): string | null {
  const said: { words: string | null; account: AccountView } = { words: null, account };
  return said.words;
}

/** "account · provider · model" — the model left off when the run names none. */
export function accountLine(
  id: string | null | undefined,
  accounts: readonly AccountView[] | undefined,
  model?: string | null,
): string {
  return [payerWho(id, accounts), payerProvider(id, accounts), model || null].filter(Boolean).join(' · ');
}
