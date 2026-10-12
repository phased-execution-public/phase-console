/** The outbound-webhook register. */

import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { keys } from './keys';

/**
 * The outbound-webhook register.
 *
 * `retry: false` for the same reason as `usePush`: a console whose server
 * predates this endpoint answers 404 and will keep answering 404, and the card
 * hides itself rather than retrying into a wall.
 */
export function useWebhooks(enabled = true) {
  return useQuery({ queryKey: keys.webhooks(), queryFn: api.webhooks, enabled, retry: false });
}
