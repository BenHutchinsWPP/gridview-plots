// src/app/notes-ledger.ts
//
// The batch notes, and the one place their order is decided.
//
// WHY CHANNELS AT ALL, rather than one array everything appends to. Each
// channel is rewritten WHOLESALE by the drop that owns it, so a bus drop
// cannot erase the account of the interface drop before it, and a note cannot
// outlive the batch it describes. One shared array makes every drop choose
// between those two: append and stale notes accumulate, replace and the other
// kinds' accounts vanish. The split is about WHEN a note dies, never about
// where it appears -- every channel is concatenated into one list at both
// render sites.
//
// WHY A LEDGER, rather than the four variables this replaces. The
// concatenation order is what the user reads, and it was written out at two
// sites that had to agree; a fifth channel meant two remembered edits, and
// forgetting the second put a kind's warnings under the panes but not on the
// empty state, which is all a refused drop leaves on screen.
// The order is declared once, here, at construction.
//
// A FACTORY, never a module-level store. The composition root holds the app's
// mutable state; a `let` in this file would be that state with an import in
// front of it.
//
// The channel names are the TYPE, taken from the order handed in: a channel
// set but never published would drop that kind's warnings -- refusals included
// -- on the floor in silence, which is the failure this module exists to stop.
// A typo, or a fifth kind added at a call site and not to the order, is a
// compile error rather than a quiet one.

/**
 * @param order The channels, in the order they are read on screen. A channel
 *   set but not named here would be held and never shown, so naming one is the
 *   act that publishes it.
 */
export function createNotesLedger<C extends string>(order: readonly C[]) {
  const channels = new Map<C, readonly string[]>();
  const sequence = [...order];
  return {
    /**
     * Rewrite one channel wholesale. Replaces, never appends -- an append is
     * how a note from the previous drop survives into an account of this one.
     * A channel set to `[]` contributes nothing, which is how a drop that
     * carried no file of a kind clears that kind's last batch.
     */
    set(channel: C, messages: readonly string[]): void {
      channels.set(channel, [...messages]);
    },
    /** Every channel, in the order given at construction. */
    all(): string[] {
      const out: string[] = [];
      for (const channel of sequence) out.push(...(channels.get(channel) ?? []));
      return out;
    },
  };
}
