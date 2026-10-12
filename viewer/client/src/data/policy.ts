/** The permission rules, at one scope. */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';
import { keys } from './keys';

/**
 * The permission rules, at one scope.
 *
 * `retry: false` because a console whose server predates the policy endpoint
 * answers 404 and will keep answering 404; the card hides rather than retrying
 * at somebody.
 *
 * `keepPrevious` holds the last scope's answer on screen while another scope
 * is read (`isPlaceholderData` says so), so a page whose scope picker sits
 * inside what it draws keeps the picker — and the focus on it — mounted. A
 * reader that does so must not WRITE against the held answer.
 */
export function usePolicy(slug: string | undefined, options: { keepPrevious?: boolean } = {}) {
  return useQuery({
    queryKey: keys.policy(slug ?? ''),
    queryFn: () => api.policy(slug || undefined),
    retry: false,
    ...(options.keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });
}
