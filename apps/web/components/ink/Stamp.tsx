import type { Rating } from '@whale-street/core';
import { stampTone } from '../../lib/ink';

export function Stamp({ rating }: { rating: Rating | null | undefined }) {
  if (!rating) return null;
  return (
    <span className="ws-stamp" data-tone={stampTone(rating)} title={`Rating ${rating}`}>
      <span className="ws-stamp__t">{rating}</span>
    </span>
  );
}
