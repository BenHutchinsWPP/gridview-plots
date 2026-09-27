// src/app/group-editing.ts
//
// Loading, editing and restoring an authored group map, written once for the
// kinds whose groups are a membership keyed on the entity axis (Generator,
// Bus, Interface). A kind states what differs as a `GroupKind`; the root
// implements `GroupEditingHost`, so this module holds no map, no revision and
// no DOM id.
//
// Area's groupings are a different thing (a CSV that also widens the area
// axis, adopted through its own refusal path) and stay in the root.

import type { BrowseRowRef } from '../ui/browse-model';
import type { EditorApplied } from '../ui/membership-editor';

/** The kinds whose groups are an authored membership. */
export type GroupedKind = 'generator' | 'bus' | 'interface';

/** The entities a browse tab showed, handed to the editor as its picker. */
export interface ShownMembers<Key> {
  members: ReadonlySet<Key>;
  /** Open with them on the right, as "add shown" does. */
  open: boolean;
}

/** What the root does for every kind. */
export interface GroupEditingHost {
  /** Replace the `session` notes channel. */
  say(lines: string[]): void;
  render(): void;
  /** An editor's Apply, after its membership is adopted: record the file it
   * loaded, or flag the kind's groups row as edited. */
  recordEditor(kind: GroupedKind, applied: EditorApplied<unknown>): void;
}

/** What one kind's groups differ in. Every function reads the kind's current
 * map and lookups fresh; none is cached here. */
export interface GroupKind<Key, Edit, Mapping, Saved, Summary> {
  kind: GroupedKind;
  nouns: {
    /** Capitalised, as its tab is named: `Generator`. */
    tab: string;
    /** One member and several, in notes: `unit`, `units`, `unit(s)`. */
    member: string;
    members: string;
    counted: string;
    /** What membership is keyed on: `name`, `bus number`. */
    keyedBy: string;
  };
  /** A tab row's entity as a member key, or undefined to skip the row. */
  keyOf(entity: string | number): Key | undefined;
  /** Open the kind's editor over the current universe. */
  edit(from: ShownMembers<Key> | undefined): Promise<EditorApplied<Edit> | null>;
  /** Replace the map from a membership file; throws on a file it refuses. */
  load(text: string, mapping: Mapping): Summary;
  /** Replace the map with the editor's answer. */
  set(edit: Edit): void;
  summarize(): Summary;
  notes(summary: Summary, lead: string): string[];
  exported(): Saved | null;
  adopt(saved: Saved): void;
  /** Move the kind's revision, which the browse rebuild key reads. */
  bump(): void;
}

export interface GroupEditing<Mapping, Saved> {
  /** Load a membership file dropped with an explicit mapping, returning notes
   * for the drop rather than writing them. */
  loadFile(text: string, mapping: Mapping, lead: string): string[];
  /** The groups tab's Edit: the entity tab's filtered rows as the picker. */
  editFromTab(rows: readonly BrowseRowRef[] | undefined): void;
  /** The entity tab's "add shown": its shown rows, open on the right. */
  addShown(shown: readonly BrowseRowRef[]): void;
  /** Take on a bundle's map. One carrying none leaves the session's alone:
   * that is a study saved with no map, not an instruction to forget one. */
  adoptSaved(saved: Saved | null, source: string): string[];
}

export function groupEditing<Key, Edit, Mapping, Saved, Summary>(
  spec: GroupKind<Key, Edit, Mapping, Saved, Summary>,
  host: GroupEditingHost,
): GroupEditing<Mapping, Saved> {
  const { tab, member, members, counted, keyedBy } = spec.nouns;
  const lower = tab.toLowerCase();

  /** Rows are per (case, slot, entity), so the set is the union and a caller
   * states both counts when they differ. Grouped rows (buckets, not members)
   * are dropped. Undefined (nothing to offer) differs from an empty set (a
   * narrowing that keeps nothing). */
  function shownMembers(
    rows: readonly BrowseRowRef[] | undefined,
    open: boolean,
  ): ShownMembers<Key> | undefined {
    if (rows === undefined) return undefined;
    const keys = new Set<Key>();
    for (const ref of rows) {
      if (ref.groupBy !== undefined) continue;
      const key = spec.keyOf(ref.entity);
      if (key !== undefined) keys.add(key);
    }
    return keys.size === 0 ? undefined : { members: keys, open };
  }

  function open(from: ShownMembers<Key> | undefined): void {
    void spec.edit(from).then((edit) => {
      if (edit === null) return;
      try {
        spec.set(edit.value);
        spec.bump();
        host.say(spec.notes(spec.summarize(), `${tab} groups updated`));
        host.render();
        host.recordEditor(spec.kind, edit);
      } catch (error) {
        host.say([error instanceof Error ? error.message : String(error)]);
        host.render();
      }
    });
  }

  return {
    loadFile(text, mapping, lead) {
      const summary = spec.load(text, mapping);
      spec.bump();
      return spec.notes(summary, `${lead}: ${lower} groups loaded`);
    },
    editFromTab(rows) {
      open(shownMembers(rows, false));
    },
    addShown(shown) {
      // Filtering the table is a better picker than a modal's list. Only keys
      // cross, and the editor still applies or cancels as a whole.
      const from = shownMembers(shown, true);
      if (from === undefined) {
        host.say([
          `Nothing to add: the ${tab} tab is showing no rows, so its filters keep no ${members}.`,
        ]);
        host.render();
        return;
      }
      if (from.members.size !== shown.length) {
        host.say([
          `${tab} groups: ${shown.length.toLocaleString()} shown row(s) are ` +
            `${from.members.size.toLocaleString()} distinct ${counted} — membership is by ` +
            `${keyedBy}, so a ${member} in several cases is one member.`,
        ]);
        host.render();
      }
      open(from);
    },
    adoptSaved(saved, source) {
      if (saved === null) {
        return [
          `${source} carried no ${lower} group membership — the map now loaded was left alone.`,
        ];
      }
      if (JSON.stringify(spec.exported()) === JSON.stringify(saved)) return [];
      spec.adopt(saved);
      spec.bump();
      return spec.notes(spec.summarize(), `${tab} groups came from ${source}`);
    },
  };
}
