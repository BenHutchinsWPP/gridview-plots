// src/inventory/store.ts
//
// The session's inventory: which file built which table, for the Contents
// panel. It sits beside the lookups and limits, not in the Case store, and is
// not a `TableKind`: a file is not a table (one long file is several tables,
// and one merged table is several files).
//
// A FACTORY, never a module-level store: the composition root holds app
// state, and each test gets a fresh inventory.
//
// **It names no kind.** The pivot's columns, the session strip's rows and
// their "enables" lines are handed in by the caller (from the kind registry,
// the lookup schemas and the limits module), so a new kind or input is a new
// column or row without an edit here.
//
// Two kinds of entry: a SLOT entry is per Case (an hourly table, or a Case's
// own limits file); a SESSION entry serves every Case (a reference list, the
// shared limits, a group file). A column may fall back to a session entry, as
// a Case with no limits of its own draws on the shared ones.
//
// Records are keyed on the `File` object, never its name: two files of one
// name in one drop are two records, and one long file behind several metric
// slots is one record listed under each.

import type { IngestOutcome, SourceCounts, TableSource } from '../app/batch';

// Session-input keys and the per-Case limits column. **Wire format**: a
// bundle's inventory names its rows by them, so renaming one orphans every
// saved row. The lookup inputs are the lists' own variants (`buslist`).

/** The shared limits' session input. Not a kind. */
export const SHARED_LIMITS_INPUT = 'limits (shared)';
/** The pivot column a Case's own limits file sits in. Not a kind. */
export const LIMITS_COLUMN = 'limits';
/** The session input a kind's group file loads into. */
export function groupsInput(kind: string): string {
  return `groups:${kind}`;
}

/** One slot a record can sit behind. `kind` is opaque here. */
export interface InventorySlot {
  kind: string;
  variant?: string;
}

/** Everything recorded about one accepted file. */
export interface FileRecord {
  /** Synthetic, unique within the inventory. */
  id: string;
  /** `null` when the file's name was never recorded. */
  name: string | null;
  size: number | null;
  /** Milliseconds since the epoch, as the browser reported it. */
  lastModified: number | null;
  loadedAt: number | null;
  /** The final kind (the import plan's, after any correction). */
  kind: string | null;
  shape: TableSource['shape'] | null;
  /** Every variant this file filled, in the order it filled them. Empty for
   * a session input, which has none. */
  variants: string[];
  /** Measured at ingest; later axis widening does not change them. */
  counts: SourceCounts | null;
  /** Notes attributed to this file by structure, never by its name. */
  notes: string[];
  /** Rebuilt from a bundle saved before the inventory existed, from what the
   * bundle held. Never saved: the next save writes it as an ordinary record. */
  reconstructed?: true;
}

/** A Case as the pivot shows it, in the order the caller wants rows. */
export interface InventoryCase {
  id: string;
  /** The Case's label (`caseLabel`), what every row reads. */
  name: string;
  /** The name drops join on, set only when the label differs from it. */
  original?: string;
  color: string;
}

/** One pivot column: a registered kind, or a per-Case input such as limits. */
export interface InventoryColumn {
  kind: string;
  label: string;
  /** What loading this makes possible, for the header's tooltip. */
  enables: string;
  /** A session input a Case with no entry of its own draws on, and the word
   * its cell then shows (muted), e.g. `shared`. */
  fallback?: { input: string; label: string };
}

/** One session-strip row, as the caller declares it. */
export interface SessionRow {
  input: string;
  label: string;
  enables: string;
}

/** One file as a pivot cell names it. */
export interface CellFile {
  id: string;
  /** `null` when not recorded. */
  name: string | null;
}

/** One table in a cell: `variant: file + file`. */
export interface CellLine {
  variant?: string;
  files: CellFile[];
}

/** One pivot cell. Empty `lines` and no `fallback` is a blank. */
export interface PivotCell {
  lines: CellLine[];
  /** Set when the Case has nothing of its own here and draws on a session
   * input instead: the word to show, muted. */
  fallback?: string;
}

/**
 * What a pivot cell says in one line: how many metrics, or, where the slot
 * has no variant to count (Area, a Case's own limits), how many files. The
 * files themselves are one click further, so a busy Case never sets the
 * height of every row. `undefined` when the cell is blank or a fallback.
 */
export function cellSummary(cell: PivotCell): string | undefined {
  if (cell.lines.length === 0) return undefined;
  if (cell.lines.every((line) => line.variant !== undefined)) {
    const n = cell.lines.length;
    return `${n.toLocaleString()} ${n === 1 ? 'metric' : 'metrics'}`;
  }
  const n = new Set(cell.lines.flatMap((line) => line.files.map((file) => file.id))).size;
  return `${n.toLocaleString()} ${n === 1 ? 'file' : 'files'}`;
}

export interface PivotRow {
  caseId: string;
  name: string;
  /** See `InventoryCase.original`. */
  original?: string;
  color: string;
  /** One per column, in column order. */
  cells: PivotCell[];
}

export interface PivotView {
  columns: InventoryColumn[];
  rows: PivotRow[];
}

/** One session-strip row as shown: every file behind the input, or none. */
export interface StripRow extends SessionRow {
  files: CellFile[];
  /** The user changed the loaded file's content in the app before applying. */
  editedInApp: boolean;
}

/** One labelled line of a record's detail. */
export interface DetailField {
  label: string;
  value: string;
}

export interface RecordDetail {
  title: string;
  fields: DetailField[];
  notes: string[];
}

/** What happened to a file, as the Log states it. `restored` and `dropped at
 * restore` are the bundle's; the rest are a drop's or an editor's. */
export type LogEventKind =
  'loaded' | 'partial' | 'replaced' | 'refused' | 'skipped' | 'restored' | 'dropped at restore';

/** A file as an event names it. A refused or skipped file was never
 * accepted, so it has no record: only what the browser said about it. */
export interface LogFile {
  record?: string;
  name: string | null;
  size: number | null;
  lastModified: number | null;
}

/** One Log entry. Plain data, so a bundle can carry the Log. */
export interface LogEvent {
  event: LogEventKind;
  at: number;
  files: LogFile[];
  /** Where it happened: a Case's slot, or a session input. */
  caseId?: string;
  slot?: InventorySlot;
  input?: string;
  reason?: string;
  /** Notes said about the whole drop rather than one file, on its `loaded`. */
  notes: string[];
}

/** One Log entry as the panel shows it. */
export interface LogLine {
  event: LogEventKind;
  at: string;
  files: { id?: string; name: string | null }[];
  /** `Case · Column: variant`, or a strip row's label. */
  where?: string;
  reason?: string;
  notes: string[];
}

/** What the Log needs to name a place: the Cases (loaded or not, by id), the
 * pivot's columns and the strip's rows, as the caller declares them. */
export interface LogContext {
  cases: readonly { id: string; name: string }[];
  columns: readonly InventoryColumn[];
  rows: readonly SessionRow[];
}

/** The copied table's columns. `State` is `loaded`, `blank`, or the word a
 * Case's cell falls back to (`shared`), so a blank row is never mistaken for
 * a file whose name was not recorded. */
const TSV_HEADER = [
  'Case',
  'Input',
  'Variant',
  'State',
  'File',
  'Size (bytes)',
  'Last modified',
  'Loaded',
  'Kind',
  'Shape',
  'Variants',
  'Counted',
  'Kept',
  'In file',
  'Edited in app',
  'Notes',
];

/** A tab or line break inside a value would start a new cell or row in the
 * pasted sheet, so each becomes a space. */
function tsvCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

/** What a missing filename reads as, everywhere it is shown. */
export const NOT_RECORDED = 'not recorded';

interface SlotEntry {
  slot: InventorySlot;
  records: string[];
}

interface SessionEntry {
  records: string[];
  editedInApp: boolean;
}

/**
 * The inventory as a bundle carries it: plain JSON, every Case named by its
 * INDEX in the manifest's `cases`, never a Case id (a restore mints fresh
 * ones). Record ids are the saving session's; a restore renumbers them.
 */
export interface SavedInventory {
  records: FileRecord[];
  slots: { case: number; slot: InventorySlot; records: string[] }[];
  session: { input: string; records: string[]; editedInApp: boolean }[];
  /** A Case the bundle does not carry leaves its event with no `case`. */
  log: (Omit<LogEvent, 'caseId'> & { case?: number })[];
  about: string;
}

/** The live inventory as `saveInventory` reads it: Cases by id. */
export interface InventorySnapshot {
  records: ReadonlyMap<string, FileRecord>;
  slots: ReadonlyMap<string, readonly { slot: InventorySlot; records: readonly string[] }[]>;
  session: ReadonlyMap<string, { records: readonly string[]; editedInApp: boolean }>;
  log: readonly LogEvent[];
  about: string;
}

/** What a restore took up, for reconciling the bundle's inventory with it. */
export interface RestoreContext {
  /** The Cases the restore made: `made[i]` is the manifest's `cases[i]`. */
  made: readonly { id: string }[];
  /** Whether a slot of a made Case holds what the bundle carried there. */
  present(caseId: string, slot: InventorySlot): boolean;
  /** Session inputs the bundle carried AND the restore adopted. Any other
   * row is left as it was: a sparse bundle is not an instruction to forget. */
  adopted: ReadonlySet<string>;
  /** The bundle file, or where it was read from ("origin-private storage"). */
  source: File | string;
}

/** Why a record the bundle listed is not in the restored session. */
const DROPPED_AT_RESTORE =
  'the bundle carried it, but this restore could not take it up (see the restore notes)';

/** NUL-separated, so no variant text can collide with another slot. */
function slotId(slot: InventorySlot): string {
  return `${slot.kind}\u0000${slot.variant ?? ''}`;
}

/** Build a session's inventory. `now` is injected for tests. */
export function createInventory(now: () => number = () => Date.now()) {
  const records = new Map<string, FileRecord>();
  /** A File's record, by identity: a same-named second file is a new one. */
  const byFile = new WeakMap<object, string>();
  /** Files the Log names without a record: refused, skipped or restored. */
  const logged = new WeakSet<object>();
  /** Case id -> slot id -> the records behind that slot. */
  const slots = new Map<string, Map<string, SlotEntry>>();
  /** Session input -> the records behind it. */
  const session = new Map<string, SessionEntry>();
  /** Append-only and uncapped: a replaced file is explained only here. */
  const log: LogEvent[] = [];
  /** The drop in progress: its events are written when it ends, so one
   * `loaded` can carry the notes that name no file. `null` outside a drop,
   * where each record logs itself at once (an editor's Apply). */
  let drop: {
    touched: string[];
    /** Slots each touched record filled in this drop. */
    filled: Map<string, number>;
    partial: Map<string, { failed: number; reason?: string }>;
    notes: string[];
  } | null = null;
  let nextId = 1;
  /** The bundle's "About" note: free text, saved with the bundle. */
  let about = '';

  function logFile(file: File): LogFile {
    logged.add(file);
    const record = byFile.get(file);
    return {
      ...(record === undefined ? {} : { record }),
      name: file.name,
      size: file.size,
      lastModified: Number.isFinite(file.lastModified) ? file.lastModified : null,
    };
  }

  function recordFile(id: string): LogFile {
    const record = records.get(id) as FileRecord;
    return { record: id, name: record.name, size: record.size, lastModified: record.lastModified };
  }

  function append(event: Omit<LogEvent, 'at' | 'notes'> & { notes?: string[] }): void {
    log.push({ ...event, at: now(), notes: event.notes ?? [] });
  }

  /** A record was accepted: in a drop it waits for the drop's end; outside
   * one it is logged now. */
  function touch(ids: readonly string[], reason?: string): void {
    if (drop === null) {
      if (ids.length > 0) {
        append({
          event: 'loaded',
          files: ids.map(recordFile),
          ...(reason === undefined ? {} : { reason }),
        });
      }
      return;
    }
    for (const id of ids) {
      if (!drop.touched.includes(id)) drop.touched.push(id);
      drop.filled.set(id, (drop.filled.get(id) ?? 0) + 1);
    }
  }

  /** Records `before` lists that `after` does not: superseded, and the Log
   * is the only place they are still named. */
  function logReplaced(
    before: readonly string[],
    after: readonly string[],
    where: Pick<LogEvent, 'caseId' | 'slot' | 'input'>,
  ): void {
    const gone = before.filter((id) => !after.includes(id));
    if (gone.length === 0) return;
    const by = after.map((id) => records.get(id)?.name ?? NOT_RECORDED).join(' + ');
    append({ event: 'replaced', files: gone.map(recordFile), ...where, reason: `by ${by}` });
  }

  function recordFor(file: File): FileRecord {
    const known = byFile.get(file);
    if (known !== undefined) return records.get(known) as FileRecord;
    const record: FileRecord = {
      id: `f${nextId++}`,
      name: file.name,
      size: file.size,
      lastModified: Number.isFinite(file.lastModified) ? file.lastModified : null,
      loadedAt: now(),
      kind: null,
      shape: null,
      variants: [],
      counts: null,
      notes: [],
    };
    records.set(record.id, record);
    byFile.set(file, record.id);
    return record;
  }

  /** The records behind every slot of the given Cases and every session
   * input, deduplicated. */
  function liveRecordIds(caseIds: Iterable<string>): Set<string> {
    const ids = new Set<string>();
    for (const caseId of caseIds) {
      for (const entry of slots.get(caseId)?.values() ?? []) {
        for (const id of entry.records) ids.add(id);
      }
    }
    for (const entry of session.values()) for (const id of entry.records) ids.add(id);
    return ids;
  }

  function setSlot(caseId: string, slot: InventorySlot, ids: string[]): void {
    let caseSlots = slots.get(caseId);
    if (caseSlots === undefined) {
      caseSlots = new Map();
      slots.set(caseId, caseSlots);
    }
    const before = caseSlots.get(slotId(slot))?.records ?? [];
    caseSlots.set(slotId(slot), { slot: { ...slot }, records: ids });
    logReplaced(before, ids, { caseId, slot: { ...slot } });
  }

  /** Files turned away: never recorded, only logged. */
  function logRefused(files: readonly File[], reason: string): void {
    if (files.length > 0) append({ event: 'refused', files: files.map(logFile), reason });
  }

  /** Files the user took out of the load (removed, or a dialog cancelled):
   * never recorded, only logged, and never mistaken for a refusal. */
  function logSkipped(files: readonly File[], reason: string): void {
    if (files.length > 0) append({ event: 'skipped', files: files.map(logFile), reason });
  }

  /** Attach a note to every listed file that has a record. Returns the
   * files that had none (they loaded nothing), for the caller to place. */
  function noteFiles(files: readonly File[], note: string): File[] {
    const unplaced: File[] = [];
    for (const file of files) {
      const id = byFile.get(file);
      if (id === undefined) {
        unplaced.push(file);
        continue;
      }
      const record = records.get(id) as FileRecord;
      if (!record.notes.includes(note)) record.notes.push(note);
    }
    return unplaced;
  }

  /** A note about the drop as a whole: it rides on the drop's `loaded`, or
   * is logged on its own outside a drop, so nothing said at load is lost. */
  function noteDrop(note: string): void {
    if (drop === null) append({ event: 'loaded', files: [], notes: [note] });
    else if (!drop.notes.includes(note)) drop.notes.push(note);
  }

  const cellFile = (id: string): CellFile => ({ id, name: (records.get(id) as FileRecord).name });

  /** Records nothing references any more: a restore replaced the pivot and
   * the Log, so what only they named is gone. */
  function prune(): void {
    const kept = liveRecordIds(slots.keys());
    for (const event of log) for (const file of event.files) if (file.record) kept.add(file.record);
    for (const id of drop?.touched ?? []) kept.add(id);
    for (const id of records.keys()) if (!kept.has(id)) records.delete(id);
  }

  const api = {
    logRefused,
    logSkipped,
    noteFiles,
    noteDrop,

    /**
     * A table was attached at (Case, slot), built from `sources`. Replaces
     * whatever that slot listed before: the slot now holds this table.
     */
    recordTable(caseId: string, slot: InventorySlot, sources: readonly TableSource[]): void {
      const ids = sources.map((source) => {
        const record = recordFor(source.file);
        record.kind = slot.kind;
        record.shape = source.shape;
        record.counts = { ...source.counts };
        if (slot.variant !== undefined && !record.variants.includes(slot.variant)) {
          record.variants.push(slot.variant);
        }
        return record.id;
      });
      setSlot(caseId, slot, ids);
      touch(ids);
    },

    /** A per-Case input file that is not an hourly table (a Case's own limits),
     * shown under the column keyed `column`. Replaces what it listed. */
    recordCaseFile(caseId: string, column: string, file: File, kind: string): void {
      const record = recordFor(file);
      record.kind = kind;
      setSlot(caseId, { kind: column }, [record.id]);
      touch([record.id]);
    },

    /**
     * A session input was loaded from `files`. `merge` adds them to what the
     * input already lists, as a reference list merges a second file into the
     * first; otherwise they replace it, as a second shared limits file does.
     * `partial` says what of the file was left out (duplicate keys dropped),
     * and logs it `partial` rather than `loaded`.
     */
    recordSessionInput(
      input: string,
      files: readonly File[],
      kind: string,
      {
        merge = false,
        editedInApp = false,
        partial,
      }: { merge?: boolean; editedInApp?: boolean; partial?: string } = {},
    ): void {
      const ids = files.map((file) => {
        const record = recordFor(file);
        record.kind = kind;
        return record.id;
      });
      const previous = session.get(input)?.records ?? [];
      const before = merge ? previous : [];
      const after = [...before, ...ids.filter((id) => !before.includes(id))];
      session.set(input, { records: after, editedInApp });
      logReplaced(previous, after, { input });
      const edited = editedInApp ? 'edited in app before Apply' : undefined;
      if (partial === undefined) {
        touch(ids, edited);
      } else if (drop === null) {
        append({
          event: 'partial',
          files: ids.map(recordFile),
          input,
          reason: edited === undefined ? partial : `${partial}; ${edited}`,
        });
      } else {
        touch(ids);
        for (const id of ids) drop.partial.set(id, { failed: 0, reason: partial });
      }
    },

    /** A restore that was turned away before any file was read, such as a
     * bad origin-private blob: there is no `File` to name, only its place. */
    logRefusedSource(source: string, reason: string): void {
      append({
        event: 'refused',
        files: [{ name: source, size: null, lastModified: null }],
        reason,
      });
    },

    about(): string {
      return about;
    },

    setAbout(text: string): void {
      about = text;
    },

    /** Everything a bundle saves, still keyed by live Case id. */
    snapshot(): InventorySnapshot {
      const bySlot = new Map<string, { slot: InventorySlot; records: string[] }[]>();
      for (const [caseId, caseSlots] of slots) {
        bySlot.set(
          caseId,
          [...caseSlots.values()].map((entry) => ({
            slot: { ...entry.slot },
            records: [...entry.records],
          })),
        );
      }
      return {
        records: new Map([...records].map(([id, record]) => [id, copyRecord(record)])),
        slots: bySlot,
        session: new Map(
          [...session].map(([input, entry]) => [
            input,
            { records: [...entry.records], editedInApp: entry.editedInApp },
          ]),
        ),
        log: log.map((event) => ({ ...event, files: event.files.map((file) => ({ ...file })) })),
        about,
      };
    },

    /**
     * Take up a restored bundle's inventory: the pivot and the Log become the
     * bundle's, then `restored` is logged. A session row is replaced only when
     * the bundle carried that input and the restore adopted it (to nothing,
     * when the bundle recorded no file for it). Whatever the bundle listed
     * that the restore did not take up is logged `dropped at restore`.
     */
    restore(saved: SavedInventory, context: RestoreContext): void {
      const renamed = new Map<string, string>();
      for (const record of saved.records) {
        const id = `f${nextId++}`;
        renamed.set(record.id, id);
        records.set(id, { ...copyRecord(record), id });
      }
      const ids = (list: readonly string[]) =>
        list.flatMap((id) => (renamed.has(id) ? [renamed.get(id) as string] : []));
      const dropped: Omit<LogEvent, 'at' | 'notes'>[] = [];

      slots.clear();
      for (const entry of saved.slots) {
        const owner = context.made[entry.case];
        const files = ids(entry.records);
        if (owner !== undefined && context.present(owner.id, entry.slot)) {
          let caseSlots = slots.get(owner.id);
          if (caseSlots === undefined) {
            caseSlots = new Map();
            slots.set(owner.id, caseSlots);
          }
          caseSlots.set(slotId(entry.slot), { slot: { ...entry.slot }, records: files });
        } else if (files.length > 0) {
          dropped.push({
            event: 'dropped at restore',
            files: files.map(recordFile),
            ...(owner === undefined ? {} : { caseId: owner.id }),
            slot: { ...entry.slot },
          });
        }
      }

      const carried = new Map(saved.session.map((entry) => [entry.input, entry]));
      for (const input of context.adopted) {
        const entry = carried.get(input);
        if (entry === undefined) session.delete(input);
        else session.set(input, { records: ids(entry.records), editedInApp: entry.editedInApp });
      }
      for (const entry of saved.session) {
        const files = ids(entry.records);
        if (context.adopted.has(entry.input) || files.length === 0) continue;
        dropped.push({
          event: 'dropped at restore',
          files: files.map(recordFile),
          input: entry.input,
        });
      }

      log.length = 0;
      for (const event of saved.log) {
        const { case: index, ...rest } = event;
        const owner = index === undefined ? undefined : context.made[index];
        log.push({
          ...rest,
          files: rest.files.map((file) => {
            const { record, ...named } = file;
            const id = record === undefined ? undefined : renamed.get(record);
            return id === undefined ? named : { ...named, record: id };
          }),
          ...(owner === undefined ? {} : { caseId: owner.id }),
          notes: [...rest.notes],
        });
      }
      about = saved.about;
      const source = context.source;
      if (typeof source === 'string') {
        append({ event: 'restored', files: [], reason: `from ${source}` });
      } else {
        append({ event: 'restored', files: [logFile(source)] });
      }
      for (const event of dropped) append({ ...event, reason: DROPPED_AT_RESTORE });
      prune();
    },

    /** The input's content was changed in the app with no new file: its row
     * still names the file it came from, flagged. A blank row stays blank. */
    markEdited(input: string): void {
      const entry = session.get(input);
      if (entry !== undefined && entry.records.length > 0) entry.editedInApp = true;
    },

    /** Open a drop: until `endDrop`, accepted files are gathered into one
     * `loaded` event, and files a failure also names become `partial`. */
    beginDrop(): void {
      drop = { touched: [], filled: new Map(), partial: new Map(), notes: [] };
    },

    /** Close the drop and write its events: one `partial` per file that
     * loaded in part, then one `loaded` naming the rest and carrying every
     * note that named no file (or only files that loaded nothing). */
    endDrop(notes: readonly string[] = []): void {
      if (drop === null) return;
      const ended = drop;
      drop = null;
      for (const [id, partial] of ended.partial) {
        const filled = ended.filled.get(id) ?? 0;
        append({
          event: 'partial',
          files: [recordFile(id)],
          reason:
            partial.reason ??
            `${filled.toLocaleString()} of ${(filled + partial.failed).toLocaleString()} ` +
              `slot(s) loaded`,
          notes: [...(records.get(id) as FileRecord).notes],
        });
      }
      const loaded = ended.touched.filter((id) => !ended.partial.has(id));
      const batchNotes = [...ended.notes, ...notes.filter((note) => !ended.notes.includes(note))];
      if (loaded.length > 0 || batchNotes.length > 0) {
        append({ event: 'loaded', files: loaded.map(recordFile), notes: batchNotes });
      }
    },

    /**
     * An engine's outcome, by structure. A failure naming a file this drop
     * accepted makes it `partial`; one naming only files that loaded nothing
     * refuses them with its note (each merge member with the group's). A
     * stop skips its files. A warning goes on the records it names, and one
     * that names none, or only files that loaded nothing, goes on the drop.
     */
    recordOutcome(outcome: IngestOutcome): void {
      const accepted = (file: File): string | undefined => {
        const id = byFile.get(file);
        return id !== undefined && drop?.touched.includes(id) ? id : undefined;
      };
      for (const failure of outcome.failures) {
        const refused: File[] = [];
        for (const file of failure.files) {
          const id = accepted(file);
          if (id === undefined || drop === null) {
            refused.push(file);
            continue;
          }
          const partial = drop.partial.get(id) ?? { failed: 0 };
          partial.failed++;
          drop.partial.set(id, partial);
          const record = records.get(id) as FileRecord;
          if (!record.notes.includes(failure.note)) record.notes.push(failure.note);
        }
        logRefused(refused, failure.note);
      }
      if (outcome.stop !== undefined) {
        logSkipped(
          outcome.stop.files.filter((file) => accepted(file) === undefined),
          outcome.stop.notes.join(' ') || 'the load was cancelled before these files were read',
        );
      }
      if (outcome.refusal !== undefined) {
        logRefused(outcome.refusal.files, outcome.refusal.note);
      }
      for (const warning of outcome.warnings) {
        const unplaced = noteFiles(warning.files, warning.note);
        if (warning.files.length === 0 || unplaced.length > 0) noteDrop(warning.note);
      }
    },

    /** Every event, oldest first, with its places named for reading. */
    log(context: LogContext): LogLine[] {
      const caseName = new Map(context.cases.map((entry) => [entry.id, entry.name]));
      const where = (event: LogEvent): string | undefined => {
        if (event.input !== undefined) {
          return context.rows.find((row) => row.input === event.input)?.label ?? event.input;
        }
        if (event.caseId === undefined) return undefined;
        const name = caseName.get(event.caseId) ?? 'a Case no longer loaded';
        if (event.slot === undefined) return name;
        const label =
          context.columns.find((column) => column.kind === event.slot?.kind)?.label ??
          event.slot.kind;
        const variant =
          event.slot.variant === undefined || event.slot.variant === ''
            ? ''
            : `: ${event.slot.variant}`;
        return `${name} · ${label}${variant}`;
      };
      return log.map((event) => {
        const place = where(event);
        return {
          event: event.event,
          at: formatTime(event.at),
          files: event.files.map((file) =>
            file.record === undefined ? { name: file.name } : { id: file.record, name: file.name },
          ),
          ...(place === undefined ? {} : { where: place }),
          ...(event.reason === undefined ? {} : { reason: event.reason }),
          notes: [...event.notes],
        };
      });
    },

    /** The files neither recorded nor named in the Log: what a load that
     * threw part-way never reached, for the root to log as refused. */
    unaccounted(files: readonly File[]): File[] {
      return files.filter((file) => !byFile.has(file) && !logged.has(file));
    },

    /** How many distinct files are behind the given Cases' slots: the
     * readout's count. A file behind three slots counts once. */
    fileCount(caseIds: Iterable<string>): number {
      return liveRecordIds(caseIds).size;
    },

    /** One record, or `undefined`. */
    record(id: string): FileRecord | undefined {
      return records.get(id);
    },

    /** Cases by kind columns. Every column is present in every row, so a
     * blank cell says both what is missing and what the app can take. */
    pivot(cases: readonly InventoryCase[], columns: readonly InventoryColumn[]): PivotView {
      const rows = cases.map((entry) => {
        const caseSlots = [...(slots.get(entry.id)?.values() ?? [])];
        const cells = columns.map((column): PivotCell => {
          const lines = caseSlots
            .filter((slotEntry) => slotEntry.slot.kind === column.kind)
            .map((slotEntry) => ({
              ...(slotEntry.slot.variant === undefined || slotEntry.slot.variant === ''
                ? {}
                : { variant: slotEntry.slot.variant }),
              files: slotEntry.records.map(cellFile),
            }))
            .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''));
          const fallback = column.fallback;
          if (
            lines.length === 0 &&
            fallback !== undefined &&
            (session.get(fallback.input)?.records.length ?? 0) > 0
          ) {
            return { lines, fallback: fallback.label };
          }
          return { lines };
        });
        return {
          caseId: entry.id,
          name: entry.name,
          ...(entry.original === undefined ? {} : { original: entry.original }),
          color: entry.color,
          cells,
        };
      });
      return { columns: columns.map((column) => ({ ...column })), rows };
    },

    /** The session strip: one row per declared input, in the order given,
     * each with every file behind it (none is a blank row). */
    strip(rows: readonly SessionRow[]): StripRow[] {
      return rows.map((row) => {
        const entry = session.get(row.input);
        return {
          ...row,
          files: (entry?.records ?? []).map(cellFile),
          editedInApp: entry?.editedInApp ?? false,
        };
      });
    },

    /**
     * The long form Copy puts on the clipboard: one row per (file, slot), and
     * one per blank slot (a kind column or a session input) with an empty
     * filename, so a pasted sheet shows the gaps the screen does. Session
     * inputs come first, with no Case, as the strip sits above the pivot.
     */
    tsv(
      cases: readonly InventoryCase[],
      columns: readonly InventoryColumn[],
      rows: readonly SessionRow[],
    ): string {
      const lines: string[][] = [TSV_HEADER];
      const fileRow = (
        caseName: string,
        input: string,
        variant: string,
        state: string,
        id: string | null,
        edited = false,
      ): string[] => {
        const record = id === null ? undefined : records.get(id);
        if (record === undefined) {
          return [caseName, input, variant, state, '', '', '', '', '', '', '', '', '', '', '', ''];
        }
        return [
          caseName,
          input,
          variant,
          state,
          record.name ?? NOT_RECORDED,
          record.size === null ? '' : String(record.size),
          record.lastModified === null ? '' : formatTime(record.lastModified),
          record.loadedAt === null ? '' : formatTime(record.loadedAt),
          record.kind ?? '',
          record.shape ?? '',
          record.variants.join(', '),
          record.counts?.of ?? '',
          record.counts === null ? '' : String(record.counts.kept),
          record.counts === null ? '' : String(record.counts.inSource),
          edited ? 'yes' : '',
          record.notes.join(' | '),
        ];
      };
      for (const row of api.strip(rows)) {
        if (row.files.length === 0) lines.push(fileRow('', row.label, '', 'blank', null));
        for (const file of row.files) {
          lines.push(fileRow('', row.label, '', 'loaded', file.id, row.editedInApp));
        }
      }
      const view = api.pivot(cases, columns);
      for (const pivotRow of view.rows) {
        pivotRow.cells.forEach((cell, index) => {
          const label = view.columns[index].label;
          if (cell.lines.length === 0) {
            const state = cell.fallback ?? 'blank';
            lines.push(fileRow(pivotRow.name, label, '', state, null));
          }
          for (const line of cell.lines) {
            for (const file of line.files) {
              lines.push(fileRow(pivotRow.name, label, line.variant ?? '', 'loaded', file.id));
            }
          }
        });
      }
      return lines.map((line) => line.map(tsvCell).join('\t')).join('\n') + '\n';
    },

    /** One record, as the detail pane reads it. */
    detail(id: string): RecordDetail | undefined {
      const record = records.get(id);
      if (record === undefined) return undefined;
      const fields: DetailField[] = [
        { label: 'File', value: record.name ?? NOT_RECORDED },
        { label: 'Size', value: record.size === null ? NOT_RECORDED : formatBytes(record.size) },
        {
          label: 'Last modified',
          value: record.lastModified === null ? NOT_RECORDED : formatTime(record.lastModified),
        },
        {
          label: 'Loaded',
          value: record.loadedAt === null ? NOT_RECORDED : formatTime(record.loadedAt),
        },
        { label: 'Kind', value: record.kind ?? NOT_RECORDED },
      ];
      // A limits file or a reference list has no shape; only an hourly
      // table is read as W or L.
      if (record.shape !== null) fields.push({ label: 'Shape', value: record.shape });
      if (record.variants.length > 0) {
        fields.push({
          label: record.variants.length === 1 ? 'Variant' : 'Variants',
          value: record.variants.join(', '),
        });
      }
      if (record.counts !== null) {
        const { of, kept, inSource } = record.counts;
        fields.push({
          label: of === 'metrics' ? 'Metrics' : 'Entities',
          value: `${kept.toLocaleString()} kept of ${inSource.toLocaleString()} in the file`,
        });
      }
      if (record.reconstructed) {
        fields.push({
          label: 'Recorded',
          value: 'rebuilt from a bundle saved before filenames were kept',
        });
      }
      return { title: record.name ?? NOT_RECORDED, fields, notes: [...record.notes] };
    },
  };
  return api;
}

export type Inventory = ReturnType<typeof createInventory>;

/** A record with its arrays copied, so a saved or restored one shares
 * nothing with the live inventory. */
function copyRecord(record: FileRecord): FileRecord {
  return {
    ...record,
    variants: [...record.variants],
    counts: record.counts === null ? null : { ...record.counts },
    notes: [...record.notes],
  };
}

/**
 * The live inventory as a bundle stores it, against the bundle's own case
 * list (`caseIds` in manifest order). A Case the bundle does not carry takes
 * its slots with it; its Log events stay, naming no Case. Only records
 * something still names are written.
 */
export function saveInventory(
  snapshot: InventorySnapshot,
  caseIds: readonly string[],
): SavedInventory {
  const slots: SavedInventory['slots'] = [];
  caseIds.forEach((caseId, index) => {
    for (const entry of snapshot.slots.get(caseId) ?? []) {
      slots.push({ case: index, slot: { ...entry.slot }, records: [...entry.records] });
    }
  });
  const session: SavedInventory['session'] = [...snapshot.session].map(([input, entry]) => ({
    input,
    records: [...entry.records],
    editedInApp: entry.editedInApp,
  }));
  const log: SavedInventory['log'] = snapshot.log.map((event) => {
    const { caseId, ...rest } = event;
    const index = caseId === undefined ? -1 : caseIds.indexOf(caseId);
    return {
      ...rest,
      files: rest.files.map((file) => ({ ...file })),
      notes: [...rest.notes],
      ...(index < 0 ? {} : { case: index }),
    };
  });
  const named = new Set<string>();
  for (const entry of slots) for (const id of entry.records) named.add(id);
  for (const entry of session) for (const id of entry.records) named.add(id);
  for (const event of log) for (const file of event.files) if (file.record) named.add(file.record);
  const records = [...snapshot.records.values()]
    .filter((record) => named.has(record.id))
    .map((record) => {
      const { reconstructed: _flag, ...saved } = copyRecord(record);
      return saved;
    });
  return { records, slots, session, log, about: snapshot.about };
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || typeof value === 'number';
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
const LOG_EVENTS: readonly string[] = [
  'loaded',
  'partial',
  'replaced',
  'refused',
  'skipped',
  'restored',
  'dropped at restore',
];

function readSlot(value: unknown): InventorySlot | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, variant } = value as Partial<InventorySlot>;
  if (!isString(kind) || (variant !== undefined && !isString(variant))) return undefined;
  return variant === undefined ? { kind } : { kind, variant };
}

function readCounts(value: unknown): SourceCounts | null {
  if (typeof value !== 'object' || value === null) return null;
  const { of, kept, inSource } = value as Partial<SourceCounts>;
  if ((of !== 'metrics' && of !== 'entities') || typeof kept !== 'number') return null;
  return typeof inSource === 'number' ? { of, kept, inSource } : null;
}

/**
 * A bundle's `inventory` field, or `undefined` when it is not one. Tolerant
 * the way the limits block is: an entry that does not read is skipped, since
 * a bad inventory costs a panel row and refusing the bundle would cost the
 * study.
 */
export function readSavedInventory(raw: unknown): SavedInventory | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const written = raw as Record<string, unknown>;
  const list = (name: string): unknown[] => {
    const value = written[name];
    return Array.isArray(value) ? value : [];
  };
  const records: FileRecord[] = [];
  for (const value of list('records')) {
    if (typeof value !== 'object' || value === null) continue;
    const r = value as Record<string, unknown>;
    if (!isString(r.id)) continue;
    records.push({
      id: r.id,
      name: isString(r.name) ? r.name : null,
      size: typeof r.size === 'number' ? r.size : null,
      lastModified: typeof r.lastModified === 'number' ? r.lastModified : null,
      loadedAt: typeof r.loadedAt === 'number' ? r.loadedAt : null,
      kind: isString(r.kind) ? r.kind : null,
      shape: r.shape === 'W' || r.shape === 'L' ? r.shape : null,
      variants: isStringList(r.variants) ? [...r.variants] : [],
      counts: readCounts(r.counts),
      notes: isStringList(r.notes) ? [...r.notes] : [],
    });
  }
  const slots: SavedInventory['slots'] = [];
  for (const value of list('slots')) {
    const entry = (value ?? {}) as Record<string, unknown>;
    const slot = readSlot(entry.slot);
    if (!Number.isInteger(entry.case) || slot === undefined || !isStringList(entry.records)) {
      continue;
    }
    slots.push({ case: entry.case as number, slot, records: [...entry.records] });
  }
  const session: SavedInventory['session'] = [];
  for (const value of list('session')) {
    const entry = (value ?? {}) as Record<string, unknown>;
    if (!isString(entry.input) || !isStringList(entry.records)) continue;
    session.push({
      input: entry.input,
      records: [...entry.records],
      editedInApp: entry.editedInApp === true,
    });
  }
  const log: SavedInventory['log'] = [];
  for (const value of list('log')) {
    const entry = (value ?? {}) as Record<string, unknown>;
    if (!isString(entry.event) || !LOG_EVENTS.includes(entry.event)) continue;
    if (typeof entry.at !== 'number' || !Array.isArray(entry.files)) continue;
    const files: LogFile[] = [];
    for (const file of entry.files as unknown[]) {
      const f = (file ?? {}) as Record<string, unknown>;
      files.push({
        ...(isString(f.record) ? { record: f.record } : {}),
        name: isString(f.name) ? f.name : null,
        size: isNumberOrNull(f.size) ? f.size : null,
        lastModified: isNumberOrNull(f.lastModified) ? f.lastModified : null,
      });
    }
    const slot = readSlot(entry.slot);
    log.push({
      event: entry.event as LogEventKind,
      at: entry.at,
      files,
      ...(Number.isInteger(entry.case) ? { case: entry.case as number } : {}),
      ...(slot === undefined ? {} : { slot }),
      ...(isString(entry.input) ? { input: entry.input } : {}),
      ...(isString(entry.reason) ? { reason: entry.reason } : {}),
      notes: isStringList(entry.notes) ? [...entry.notes] : [],
    });
  }
  return {
    records,
    slots,
    session,
    log,
    about: isString(written.about) ? written.about : '',
  };
}

/** Bytes as the readout states them: exact below a KiB, else one decimal. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]} (${bytes.toLocaleString()} B)`;
}

/** A local timestamp, `YYYY-MM-DD HH:MM:SS`: sortable, and what a file
 * browser shows beside the export. */
export function formatTime(ms: number): string {
  const at = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}
