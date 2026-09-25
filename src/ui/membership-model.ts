// src/ui/membership-model.ts
//
// The many-to-many membership an editor edits, with no DOM, so its rules are
// testable (`tests/test_membership_model.mjs`) without dragging anything.
//
// WHAT IS ARBITRARY AND MUST NOT BE "TIDIED":
//
//   * Groups and members are SORTED for display, but `toCsv` writes INSERTION
//     order, so a loaded file round-trips without a spurious diff.
//   * A name may sit in any number of groups; summing over groups
//     double-counts by construction.
//   * Adding is idempotent and silent.
//   * A MARK is per (group, member), not per member: one interface may count
//     forward in one boundary and reversed in another. Marks live here so a
//     deleted group, removed member or CSV load cannot leave one behind.

/** Why a group name may not be created (it only blocks the Add). */
export type GroupNameRefusal = 'empty' | 'comma' | 'reserved' | 'duplicate';

/** What narrows the candidate column beyond "not already a member". Callbacks,
 * because both answers are the kind's (identifiers, data presence). */
export interface CandidateFilter {
  /** Extra text the needle matches as well as the name. */
  detail?(name: string): string;
  /** A named subset an editor's own control chose. */
  keep?(name: string): boolean;
}

/** A (group, member) pair, as a mark is addressed from outside. */
export type MarkKey = readonly [group: string, name: string];

export class MembershipModel {
  /** group -> member names, in the order they were added or loaded. */
  private readonly groups: Map<string, string[]>;
  /** The MARKED (group, member) pairs; a kind with no marks never writes it. */
  private marks: Set<string>;
  private current: string;
  /** Names something else computes (area's ALL_AREAS), so never created. */
  private readonly reserved: ReadonlySet<string>;

  // Fields are assigned, not constructor PARAMETER PROPERTIES: tests import
  // `.ts` through Node's strip-only type stripping, which cannot emit them
  // (nor enums or namespaces).
  constructor(
    initial: ReadonlyMap<string, readonly string[]>,
    reserved: ReadonlySet<string> = new Set(),
    marks: Iterable<MarkKey> = [],
  ) {
    this.groups = new Map([...initial].map(([group, names]) => [group, [...names]]));
    this.current = this.groups.keys().next().value ?? '';
    this.reserved = reserved;
    this.marks = new Set([...marks].map(([group, name]) => markKey(group, name)));
  }

  /** Whether this (group, member) pair is marked. */
  isMarked(group: string, name: string): boolean {
    return this.marks.has(markKey(group, name));
  }

  /** Flip a pair's mark and return it; a non-member is left alone. */
  toggleMark(group: string, name: string): boolean {
    if (!(this.groups.get(group)?.includes(name) ?? false)) return false;
    const key = markKey(group, name);
    if (this.marks.has(key)) {
      this.marks.delete(key);
      return false;
    }
    this.marks.add(key);
    return true;
  }

  /** How many of a group's members are marked. */
  markedIn(group: string): number {
    let count = 0;
    for (const name of this.groups.get(group) ?? []) {
      if (this.marks.has(markKey(group, name))) count++;
    }
    return count;
  }

  /** Every marked pair, for a caller rebuilding its own state from this one. */
  markSnapshot(): MarkKey[] {
    const out: MarkKey[] = [];
    for (const [group, names] of this.groups) {
      for (const name of names) if (this.marks.has(markKey(group, name))) out.push([group, name]);
    }
    return out;
  }

  get selected(): string {
    return this.current;
  }

  get size(): number {
    return this.groups.size;
  }

  select(group: string): void {
    this.current = group;
  }

  /** Members of the selected group; empty when none is selected. */
  members(): readonly string[] {
    return this.groups.get(this.current) ?? [];
  }

  /** Group names in reading order, with each one's size. */
  ordered(): { group: string; count: number }[] {
    return [...this.groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([group, names]) => ({ group, count: names.length }));
  }

  /** The selected group's members, in reading order. */
  sortedMembers(): string[] {
    return [...this.members()].sort((a, b) => a.localeCompare(b));
  }

  /** The candidate column: axis names not in the selected group, narrowed by
   * the filter box AND the chosen subset, in the caller's axis order. */
  candidates(axis: readonly string[], needle: string, filter: CandidateFilter = {}): string[] {
    const query = needle.trim().toLowerCase();
    const inGroup = new Set(this.members());
    return axis.filter((name) => {
      if (inGroup.has(name)) return false;
      if (filter.keep !== undefined && !filter.keep(name)) return false;
      if (!query) return true;
      // Name OR detail: an analyst may type a unit's bus number.
      if (name.toLowerCase().includes(query)) return true;
      return (filter.detail?.(name) ?? '').toLowerCase().includes(query);
    });
  }

  /** How many groups hold this name: the "in 3" badge, the only hint of
   * many-to-many membership. */
  groupsContaining(name: string): number {
    let count = 0;
    for (const names of this.groups.values()) if (names.includes(name)) count++;
    return count;
  }

  /** Add to the SELECTED group. */
  add(name: string): void {
    this.addTo(this.current, name);
  }

  /** Add to a NAMED group (dropping onto a group row). */
  addTo(group: string, name: string): void {
    const names = this.groups.get(group);
    if (!names || names.includes(name)) return;
    names.push(name);
  }

  remove(name: string): void {
    const names = this.groups.get(this.current);
    if (!names) return;
    const at = names.indexOf(name);
    if (at >= 0) names.splice(at, 1);
    // Drop the mark too, or it would reappear if the name were re-added.
    this.marks.delete(markKey(this.current, name));
  }

  /** Delete a group. The selection moves to whatever is left, or to nothing. */
  deleteGroup(group: string): void {
    for (const name of this.groups.get(group) ?? []) this.marks.delete(markKey(group, name));
    this.groups.delete(group);
    if (this.current === group) this.current = this.groups.keys().next().value ?? '';
  }

  /** Why this group name cannot be created, or null when it can. */
  refuseName(raw: string): GroupNameRefusal | null {
    const name = raw.trim();
    if (!name) return 'empty';
    // A comma would split the CSV cell.
    if (name.includes(',')) return 'comma';
    if (this.reserved.has(name)) return 'reserved';
    if (this.groups.has(name)) return 'duplicate';
    return null;
  }

  /** Create a group and select it. Returns false when the name is refused. */
  addGroup(raw: string): boolean {
    if (this.refuseName(raw) !== null) return false;
    const name = raw.trim();
    this.groups.set(name, []);
    this.current = name;
    return true;
  }

  /** Replace everything, as a CSV load does, marks included. */
  replace(next: ReadonlyMap<string, readonly string[]>, marks: Iterable<MarkKey> = []): void {
    this.groups.clear();
    for (const [group, names] of next) this.groups.set(group, [...names]);
    this.current = this.groups.keys().next().value ?? '';
    this.marks = new Set([...marks].map(([group, name]) => markKey(group, name)));
  }

  /** A copy, for handing to a caller that must not share this mutable state. */
  snapshot(): Map<string, string[]> {
    return new Map([...this.groups].map(([group, names]) => [group, [...names]]));
  }

  /** The membership as a comparable value: order-free, marks included, so
   * an edit undone by hand compares equal to where it started. */
  signature(): string {
    return JSON.stringify(
      [...this.groups]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([group, names]) => [
          group,
          [...names].sort().map((name) => [name, this.isMarked(group, name)]),
        ]),
    );
  }

  /**
   * One row per (member, group) pair, in insertion order (see the header).
   * `cells` returns the WHOLE row, so a kind decides column order and content
   * (a generator's ids sit beside the name). `extra` rows are written last:
   * rows the file must keep that are not editable membership.
   */
  toCsv(
    header: string,
    cells: (name: string, group: string, marked: boolean) => readonly string[] = (name, group) => [
      name,
      group,
    ],
    extra: readonly (readonly string[])[] = [],
  ): string {
    const lines = [header];
    for (const [group, names] of this.groups) {
      for (const name of names)
        lines.push(cells(name, group, this.isMarked(group, name)).join(','));
    }
    for (const row of extra) lines.push(row.join(','));
    return lines.join('\n') + '\n';
  }
}

/** A (group, member) key, NUL-joined because a group name may contain any
 * CSV-cell text. */
function markKey(group: string, name: string): string {
  return `${group}\u0000${name}`;
}

/** Where an applied membership came from. */
export interface LoadSource<F> {
  file: F;
  /** Changed after the load and before Apply. */
  editedInApp: boolean;
}

/**
 * Which file loaded in an editor became its membership, and whether it was
 * edited before Apply. Only a load that REPLACED the membership counts: a
 * cancelled mapping or a refused file leaves the last source standing. A
 * kind whose load closes the editor with the file's own content (Area's)
 * closes mid-load, and that file is the source, unedited.
 */
export class LoadTracker<F> {
  private loading: F | null = null;
  private replacedBy: F | null = null;
  private loaded: { file: F; signature: string } | null = null;
  private readonly opened: string;
  private readonly model: MembershipModel;

  constructor(model: MembershipModel) {
    this.model = model;
    this.opened = model.signature();
  }

  /** A file's load starts. */
  begin(file: F): void {
    this.loading = file;
    this.replacedBy = null;
  }

  /** The load in progress replaced the membership. */
  replaced(): void {
    this.replacedBy = this.loading;
  }

  /** The load settled, whatever it did. */
  end(file: F): void {
    if (this.replacedBy === file && this.loading === file) {
      this.loaded = { file, signature: this.model.signature() };
    }
    this.loading = null;
  }

  /** At Apply: the source, and whether the membership differs from the one
   * the editor opened with. */
  applied(): { source: LoadSource<F> | null; changed: boolean } {
    const now = this.model.signature();
    const source =
      this.loading !== null
        ? { file: this.loading, editedInApp: false }
        : this.loaded === null
          ? null
          : { file: this.loaded.file, editedInApp: now !== this.loaded.signature };
    return { source, changed: now !== this.opened };
  }
}
