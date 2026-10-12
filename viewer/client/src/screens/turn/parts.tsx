/**
 * What the page lends the item card (7.0, quiet-console phase 8): the
 * permission card, the owner's requests and the check's outcome are the
 * page's own; in Pro the supervisor's card is `cards/pro/`'s (phase 16), and
 * the QR of a link meant for the device in the person's hand is Fleet's
 * (`screens/fleet/lazy-qr.tsx`, phase 24) — a lazy door, so the encoder is
 * fetched when an item draws a QR and never with the page.
 */

import { ItemCard, type ItemCardParts, type ItemCardProps } from '@/cards/item-card';
import type { TurnItem } from '@/data/turn';
import { CheckOutcome } from './check';
import { OwnerRequests, PermissionCard, type PermissionCardProps } from './permission-card';

/**
 * The parts, with the page's hold wired in: a grant that went through holds
 * its item on the page until the server's `turn` event (#270).
 */
export function turnParts(onSettled?: (item: TurnItem, words: string) => void): ItemCardParts {
  const HeldPermissionCard = (props: PermissionCardProps) => (
    <PermissionCard {...props} onSettled={onSettled ? (words) => onSettled(props.item, words) : undefined} />
  );
  return {
    PermissionCard: HeldPermissionCard,
    OwnerRequests,
    CheckOutcome,
  };
}

const PARTS = turnParts();

/** The item card as Your turn draws it — the page's parts lent. */
export function TurnItemCard(props: ItemCardProps) {
  return <ItemCard {...props} parts={props.parts ?? PARTS} />;
}
