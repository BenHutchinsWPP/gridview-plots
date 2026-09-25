// src/model/case-model.ts
//
// The Case model: a Case has a synthetic, stable id and owns 0..n tables keyed
// by kind (+ variant), independent of any filename. No DOM, so it is tested in
// Node; the palette comes from `ui/palette.ts` (also DOM-free) because a
// Case's colour is fixed when it is made.

import { CASE_COLORS } from '../ui/palette';

/** Every kind of table a Case can hold. Reference lists are not tables: they
 * describe the network, and sit beside `groupings` in the envelope. */
export type TableKind = 'area' | 'interface' | 'bus' | 'generator';

/** One table slot in a Case: kind, plus a variant where one Case can hold
 * several of a kind (Power Flow and Congestion Cost from one run). */
export interface TableSlotKey {
  kind: TableKind;
  variant?: string;
}

/**
 * The slot-map key: `variant` collapses to '' when absent, so two variant-less
 * keys of one kind collide, which is what occupied-slot detection relies on.
 * The space separator assumes no `TableKind` contains a space.
 */
export function slotKey(key: TableSlotKey): string {
  return `${key.kind} ${key.variant ?? ''}`;
}

export interface Case {
  id: string; // synthetic, stable -- NEVER the source filename
  name: string; // the key a drop joins on, assigned by the import dialog
  /** What the Case is shown as, when the analyst gave it one. Only `name` is
   * matched on, so setting this re-routes no drop, limits file or pin. */
  displayName?: string;
  /** Assigned once, at drop time, and never reassigned -- see `createCase`. */
  color: string;
  tables: Map<string, { key: TableSlotKey; data: unknown }>; // unknown = AreaTable | InterfaceTable | ...
}

/**
 * What a Case is CALLED on screen, in files and in figures. `name` is the key
 * drops, limits scopes and the by-Case bucket in a pin's row id match on, so a
 * rendering surface resolves this from the Case at draw time rather than
 * copying `name` when a row is built.
 */
export function caseLabel(entry: { readonly name: string; readonly displayName?: string }): string {
  return entry.displayName || entry.name;
}

/** Case labels in reading order (`Case 2` before `Case 10`), for DISPLAY only;
 * never reorder the store, whose ids index the series pool. */
export function byCaseName(
  a: { name: string; displayName?: string },
  b: { name: string; displayName?: string },
): number {
  return caseLabel(a).localeCompare(caseLabel(b), undefined, { numeric: true });
}

/**
 * The Case a typed name means: the one with that name, else the one shown
 * as it. A drop naming either joins that Case, so typing the name on screen
 * never makes a second one.
 */
export function caseForName<C extends { name: string; displayName?: string }>(
  cases: readonly C[],
  name: string,
): C | undefined {
  return (
    cases.find((entry) => entry.name === name) ?? cases.find((entry) => entry.displayName === name)
  );
}

/**
 * Why `text` cannot be Case `id`'s display name, or undefined when it can.
 * Blank, or the Case's own name, is allowed: it clears the display name. Any
 * other Case's name or display name is refused, so two Cases never read the
 * same and a typed name never means two Cases.
 */
export function displayNameRefusal(
  cases: readonly { id: string; name: string; displayName?: string }[],
  id: string,
  text: string,
): string | undefined {
  const wanted = text.trim();
  if (wanted === '') return undefined;
  const other = cases.find(
    (entry) => entry.id !== id && (entry.name === wanted || entry.displayName === wanted),
  );
  if (other === undefined) return undefined;
  return other.name === wanted
    ? `Another Case is named "${wanted}".`
    : `Another Case is shown as "${wanted}" (its name is "${other.name}").`;
}

/** A Case as a bundle carries it: no colour, which `CaseStore.createCase`
 * assigns on restore just as for a dropped file. */
export type RestoredCase = Omit<Case, 'color'>;

function newCaseId(): string {
  // Synthetic, never a filename. randomUUID works in browsers and Node >= 19.
  return `case-${crypto.randomUUID()}`;
}

/** Owns `Case[]`. */
export class CaseStore {
  #cases = new Map<string, Case>();
  #colorCursor = 0;

  /**
   * A Case, with its colour fixed now: a PROPERTY looked up by id, never a
   * list position, so sorting for display cannot recolour lines. The cursor
   * only advances, so removing a Case recolours nothing.
   */
  createCase(name: string): Case {
    const color = CASE_COLORS[this.#colorCursor++ % CASE_COLORS.length];
    const created: Case = { id: newCaseId(), name, color, tables: new Map() };
    this.#cases.set(created.id, created);
    return created;
  }

  renameCase(id: string, name: string): void {
    this.#requireCase(id).name = name;
  }

  /** Show Case `id` as `text`; blank or its own name clears it. Throws with
   * `displayNameRefusal`'s reason when another Case already reads so. */
  setDisplayName(id: string, text: string): void {
    const target = this.#requireCase(id);
    const refusal = displayNameRefusal(this.listCases(), id, text);
    if (refusal !== undefined) throw new Error(refusal);
    const wanted = text.trim();
    if (wanted === '' || wanted === target.name) delete target.displayName;
    else target.displayName = wanted;
  }

  removeCase(id: string): void {
    // Refuse an unknown id, like every other method here.
    this.#requireCase(id);
    this.#cases.delete(id);
  }

  /** Attach `data` at `key`'s slot; throws if occupied unless `replace`. */
  attachTable(id: string, key: TableSlotKey, data: unknown, opts?: { replace?: boolean }): void {
    const c = this.#requireCase(id);
    const sk = slotKey(key);
    if (c.tables.has(sk) && !opts?.replace) {
      throw new Error(
        `case "${id}" already has a table at slot "${sk}" (pass {replace: true} to replace it)`,
      );
    }
    // Copy the key: a caller mutating it later would desync the slot string
    // from `entry.key`, which tablesOfKind filters on.
    c.tables.set(sk, { key: { ...key }, data });
  }

  detachTable(id: string, key: TableSlotKey): void {
    const c = this.#requireCase(id);
    const sk = slotKey(key);
    // Refused, like every unknown target here: a caller detaching a slot it
    // believes exists has a wrong model of the Case.
    if (!c.tables.delete(sk)) {
      throw new Error(`case "${id}" has no table at slot "${sk}"`);
    }
  }

  listCases(): Case[] {
    return [...this.#cases.values()];
  }

  /** Every table of `kind` with its slot key: one Case can hold two Interface
   * tables, so the unit is the SLOT. */
  tablesOfKind(kind: TableKind): { caseId: string; slotKey: string; data: unknown }[] {
    const out: { caseId: string; slotKey: string; data: unknown }[] = [];
    for (const c of this.#cases.values()) {
      for (const [sk, entry] of c.tables) {
        if (entry.key.kind === kind) out.push({ caseId: c.id, slotKey: sk, data: entry.data });
      }
    }
    return out;
  }

  #requireCase(id: string): Case {
    const c = this.#cases.get(id);
    if (!c) throw new Error(`no case with id "${id}"`);
    return c;
  }
}

/**
 * One browse row: one TABLE, by owning Case and slot. **The unit is the
 * SLOT**: keyed by Case, a Power Flow and a Congestion Cost table from one
 * run would share a row and a buffer.
 */
export interface TableRow<T> {
  /** `rowKeyOf(caseId, slotKey)`. */
  key: string;
  caseId: string;
  slotKey: string;
  label: string;
  data: T;
}

/**
 * A row's identity: query entries, colours and buffer keys all use it, and
 * rows are matched to tables by it (`src/app/draw.ts`), never by position.
 * Case ids contain no space, so the join is unambiguous.
 */
export function rowKeyOf(caseId: string, slotKey: string): string {
  return `${caseId} ${slotKey}`;
}

/**
 * Every loaded table of one kind, in Case creation order (the drawer's
 * order; colours come from the Case, not from this order). The caller names
 * rows, since only a kind with several tables per Case needs the variant.
 */
export function rowsOfKind<T>(
  store: CaseStore,
  kind: TableKind,
  label: (owner: Case, slotKey: string) => string,
): TableRow<T>[] {
  const byId = new Map(store.listCases().map((entry) => [entry.id, entry] as const));
  const out: TableRow<T>[] = [];
  for (const { caseId, slotKey: sk, data } of store.tablesOfKind(kind)) {
    const owner = byId.get(caseId);
    if (!owner) continue;
    out.push({
      key: rowKeyOf(caseId, sk),
      caseId,
      slotKey: sk,
      label: label(owner, sk),
      data: data as T,
    });
  }
  return out;
}

/** The label for a kind with several tables per Case: Case label and the
 * slot's quantity, or a note that the title line was unreadable. */
export function slotLabel(owner: Case, slotKey: string): string {
  const variant = owner.tables.get(slotKey)?.key.variant ?? '';
  return `${caseLabel(owner)} · ${variant || 'quantity unknown'}`;
}
