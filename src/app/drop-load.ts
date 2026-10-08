// src/app/drop-load.ts
//
// One drop, from the first byte read to the last table attached: classify
// every file, apply the auxiliary ones (bundles, groupings, lookup lists) in
// drop order, ask the Import Dialog where the tables and limits files go, run
// each (kind, shape) batch, then install the limits. The order is the point:
// limits resolve their Case by name after every ingest, the area account is
// published before the other kinds' batches can throw, and the drop is closed
// in the inventory on every exit.
//
// Like the ingest engines it takes a host and holds no app state: `main.ts`
// states the store, the dialogs, the notes and the busy line as a `DropHost`,
// so a test drives the whole sequence with a fake one. The one thing held
// here is the drop's own lifetime (whether one is running, which exit its
// Import Dialog took, and the intake that lets a later drop join that dialog
// while it is open), in a closure the root creates.

import { classify, DETECT_PROBE_BYTES, type DetectResult } from '../detect';
import { sampleYears, type SampledYears } from '../tables/long/sample-years';
import {
  groupsInput,
  LIMITS_COLUMN,
  SHARED_LIMITS_INPUT,
  type Inventory,
} from '../inventory/store';
import { parseLimitsCsv } from '../limits/parse';
import type { LimitTable } from '../limits/types';
import { parseLookupCsv, type LookupRows } from '../lookups/parse';
import { schemaFor } from '../lookups/schema';
import { VARIANT_OF } from '../lookups/types';
import {
  realHours,
  realHoursSeen,
  spanOfTable,
  YEAR_SLOT_HOURS,
  type YearSpan,
} from '../model/calendar';
import { byCaseName, caseForName, caseLabel, type Case, type TableKind } from '../model/case-model';
import type { GroupingsMappingChoice } from '../ui/groupings-mapping';
import type { ImportDecision } from '../ui/import-dialog';
import { outcomeNotes, type Drop, type IngestOutcome } from './batch';
import { routeDrop, splitPlans, type RoutedFile } from './drop-route';
import type { ExistingCase, ImportFile, LimitPlan, SlotCoverage } from './import-plan';

/** The notes channels a drop writes. `session` is cleared by a drop that runs
 * and written by one that is refused; the four kinds are the drop's account. */
export type DropChannel = 'session' | TableKind;

/** What the sequence needs from the composition root. */
export interface DropHost {
  inventory: Pick<
    Inventory,
    | 'beginDrop'
    | 'endDrop'
    | 'logRefused'
    | 'logSkipped'
    | 'noteFiles'
    | 'noteDrop'
    | 'recordOutcome'
    | 'recordSessionInput'
    | 'recordCaseFile'
    | 'unaccounted'
  >;
  /** Rewrite one notes channel wholesale. */
  say(channel: DropChannel, lines: readonly string[]): void;
  render(): void;
  /** Hold (or on `null`, release) the busy line between batches. */
  setBusyFloor(message: string | null): void;
  /** An hourly file is being written; a drop waits for it. */
  downloadRunning(): boolean;
  closeContents(): void;
  listCases(): readonly Case[];
  /** Restore a dropped bundle, returning its account rather than writing it. */
  restoreBundle(file: File): Promise<string[]>;
  /** Ask which entity a membership file groups; `null` is a cancel. */
  askGroupings(
    file: File,
    text: string,
    writtenBy: DetectResult['writtenBy'],
  ): Promise<GroupingsMappingChoice | null>;
  /** Apply a membership file as `choice` says, returning its account. Throws
   * on a file it refuses. */
  loadGroupings(choice: GroupingsMappingChoice, text: string, fileName: string): string[];
  /** A kind as its column is headed: `Bus`. */
  kindLabel(kind: TableKind): string;
  /** Merge a reference list into the session's, returning the merge's note. */
  attachLookup(rows: LookupRows, fileName: string): { alreadyKnown: number; note: string };
  askImport(
    tables: ImportFile[],
    cases: ExistingCase[],
    limits: ImportFile[],
    intake: ImportIntake,
  ): Promise<ImportDecision | null>;
  /** Run one (kind, shape) batch through its engine. */
  ingest(kind: TableKind, shape: 'W' | 'L', drops: Drop[]): Promise<IngestOutcome>;
  /** Install limits, returning the source they replaced, if any. */
  setSharedLimits(table: LimitTable): string | null;
  setCaseLimits(caseId: string, table: LimitTable): string | null;
  /** How many of a Case's monitored interfaces its limits name, when not all. */
  limitMatchNotes(caseId: string, caseName: string): string[];
  /** Every loaded Case is drawn: called once the batches have run. */
  refreshCases(): void;
  /** Open the browse drawer if it is closed. */
  revealDrawer(): void;
}

export interface DropLoad {
  /** Load a drop. Never rejects: a throw is refused in the notes and the Log. */
  load(files: File[]): Promise<void>;
  /** A drop is in flight. */
  running(): boolean;
  /** The Import Dialog's "keep everything" exit, for the batches' pickers. */
  keepsEverything(): boolean;
}

type Dropped = { file: File; classified: ImportFile };

/** Files that joined the open Import Dialog, numbered after the ones already
 * in it: `index` is what the file's plan carries back as `fileIndex`. */
export interface AddedFiles {
  tables: { index: number; file: ImportFile }[];
  limits: { index: number; file: ImportFile }[];
  /** One line per file that did not join, refused or skipped. */
  notes: string[];
}

/** The open Import Dialog's way in for more files, from a drop on the
 * window or its own Add files… button alike. */
export interface ImportIntake {
  add(files: File[]): void;
  /** The dialog takes what joins it. `shows` says whether table file `index`
   * still has a row, so a file removed with × may be added again. */
  listen(take: (added: AddedFiles) => void, shows: (index: number) => boolean): void;
}

/** Read each file's head and say what it is. */
async function classifyFiles(files: readonly File[]): Promise<RoutedFile<Dropped>[]> {
  const classified: RoutedFile<Dropped>[] = [];
  for (const file of files) {
    const headBytes = new Uint8Array(await file.slice(0, DETECT_PROBE_BYTES).arrayBuffer());
    const detected = classify(headBytes, file.name);
    const sampled = detected.shape === 'L' ? await sampleOf(file, headBytes) : undefined;
    classified.push({
      name: file.name,
      // The verdict travels with the file; its quantity (possibly undefined)
      // separates two tables of one kind on one Case.
      item: { file, classified: { name: file.name, detected, ...(sampled ? { sampled } : {}) } },
      verdict: detected,
    });
  }
  return classified;
}

/** A long file's years for the Import Dialog, from its first and last
 * `DETECT_PROBE_BYTES`; a file up to twice that is read whole. */
async function sampleOf(file: File, head: Uint8Array): Promise<SampledYears | undefined> {
  if (file.size <= head.length) return sampleYears(head, null);
  if (file.size <= 2 * DETECT_PROBE_BYTES) {
    return sampleYears(new Uint8Array(await file.arrayBuffer()), null);
  }
  const tail = file.slice(file.size - DETECT_PROBE_BYTES);
  return sampleYears(head, new Uint8Array(await tail.arrayBuffer()));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How many of its span's real hours each of a Case's occupied slots covers,
 * for the Import Dialog's replace warning. Reads `hoursPresent`, `firstYear`
 * and `numYears` structurally, so a new kind gets the warning by carrying the fields. `null`
 * means unknown (an older bundle), and the dialog then says nothing about
 * coverage.
 */
export function hoursCoveredBySlot(entry: {
  tables: Map<string, { data: unknown }>;
}): Record<string, SlotCoverage | null> {
  const out: Record<string, SlotCoverage | null> = {};
  for (const [slot, table] of entry.tables) {
    const data = table.data as {
      hoursPresent?: Uint8Array;
      firstYear?: number;
      numYears?: number;
    } | null;
    const hours = data?.hoursPresent;
    const firstYear = data?.firstYear;
    const numYears = data?.numYears;
    if (
      !(hours instanceof Uint8Array) ||
      typeof firstYear !== 'number' ||
      typeof numYears !== 'number' ||
      hours.length !== numYears * YEAR_SLOT_HOURS
    ) {
      out[slot] = null;
      continue;
    }
    out[slot] = {
      covers: realHoursSeen(hours, firstYear, numYears),
      of: realHours(firstYear, numYears),
    };
  }
  return out;
}

/** The years each of a Case's occupied slots spans, for the Import Dialog's
 * span warning; `null` is unknown. */
export function spansBySlot(entry: {
  tables: Map<string, { data: unknown }>;
}): Record<string, YearSpan | null> {
  const out: Record<string, YearSpan | null> = {};
  for (const [slot, table] of entry.tables) out[slot] = spanOfTable(table.data);
  return out;
}

export function createDropLoad(host: DropHost): DropLoad {
  const { inventory } = host;
  // Not reentrant: a second concurrent drop would dispatch over the same pool
  // while the first is in flight, and a stale reply could land in the wrong
  // case. Refusing guarantees one dispatch per kind at a time.
  let inFlight = false;
  // Which exit the Import Dialog took. Every batch reads it at a different
  // moment of one drop; cleared in the same `finally` as `inFlight`, or the
  // NEXT drop would skip its pickers.
  let everything = false;
  // Open only while the Import Dialog is: a drop then joins it, not refused.
  let intake: ImportIntake | null = null;
  // Every file this drop holds, the ones added to its dialog included, so a
  // throw refuses each file it had not reached.
  let held: File[] = [];

  function refuse(files: File[], refusal: string): void {
    inventory.logRefused(files, refusal);
    host.say('session', [refusal]);
    host.render();
  }

  async function load(files: File[]): Promise<void> {
    // Refuse a concurrent call rather than let two live dispatch() calls race
    // over the same worker pool.
    if (intake !== null) {
      intake.add(files);
      return;
    }
    if (inFlight) {
      refuse(files, 'A load is already running — drop these files again once it finishes.');
      return;
    }
    if (host.downloadRunning()) {
      refuse(files, 'A download is being written — drop these files again once it finishes.');
      return;
    }
    inFlight = true;
    held = [...files];
    host.closeContents();
    // Everything this drop accepts is logged as one `loaded` when it ends,
    // carrying the notes that name no file.
    inventory.beginDrop();
    // This drop supersedes the last non-drop message. Cleared here, not on the
    // refusal above, which superseded nothing.
    host.say('session', []);
    const plural = files.length === 1 ? '' : 's';
    host.setBusyFloor(`Reading ${files.length} dropped file${plural}…`);
    try {
      await run(files);
    } catch (error) {
      // Whatever the drop had not reached is refused by name, so no file of it
      // goes unaccounted in the Log.
      const refusal =
        `The load stopped: ${errorText(error)}. ` + 'Files it had not reached were not loaded.';
      inventory.logRefused(inventory.unaccounted(held), refusal);
      host.say('session', [refusal]);
    } finally {
      inventory.endDrop();
      inFlight = false;
      everything = false;
      intake = null;
      held = [];
      host.setBusyFloor(null);
    }
  }

  async function run(files: File[]): Promise<void> {
    // Every file in drop order with the detector's verdict. Which Case and
    // slot each lands on is the Import Dialog's answer, not this loop's.
    const classified = await classifyFiles(files);
    // WHERE each file goes is `routeDrop`, which is total over the verdict
    // union and tested on its own. What follows is the half that cannot be:
    // every auxiliary step awaits, and each writes session state.
    const route = routeDrop(classified);
    const tableFiles = route.tables.map((entry) => entry.item);
    /** Every interface limit file the drop carries. Kept apart from
     *  `tableFiles` all the way through, because it is not a table and the
     *  planner answers a different question about it. */
    const limitFiles = route.limits.map((entry) => entry.item);
    /** Messages from the routing stage itself, ahead of either ingest. */
    const routed: string[] = [];
    for (const step of route.auxiliary) {
      switch (step.action) {
        case 'message':
          routed.push(step.text);
          inventory.logRefused([step.item.file], step.text);
          break;
        case 'bundle':
          // Accumulated, not written to the notes: the ingest notes below
          // would overwrite the restore's account, including a refusal.
          routed.push(...(await host.restoreBundle(step.item.file)));
          break;
        case 'groupings':
          routed.push(...(await applyGroupingsFile(step.item)));
          break;
        case 'lookup':
          routed.push(...(await applyLookupFile(step.item.file)));
          break;
        default: {
          const unhandled: never = step;
          throw new Error(`unapplied auxiliary step: ${JSON.stringify(unhandled)}`);
        }
      }
    }
    if (tableFiles.length === 0 && limitFiles.length === 0) {
      // Nothing to ingest. A bundle restore has already written its own
      // notes; anything the routing stage said still has to be shown.
      if (routed.length > 0) {
        host.say('area', routed);
        host.render();
      }
      return;
    }

    // The Import Dialog is the ONLY place that decides which file joins which
    // Case and slot. It runs once for the whole drop, before any ingest.
    // Groupings and bundles are applied above and never reach it.
    const opened = openIntake(tableFiles, limitFiles);
    intake = opened.intake;
    const decision = await host.askImport(
      tableFiles.map((entry) => entry.classified),
      host
        .listCases()
        .slice()
        .sort(byCaseName)
        .map((entry) => ({
          name: entry.name,
          ...(entry.displayName ? { displayName: entry.displayName } : {}),
          occupiedSlots: [...entry.tables.keys()],
          slotHours: hoursCoveredBySlot(entry),
          slotSpans: spansBySlot(entry),
        })),
      limitFiles.map((entry) => entry.classified),
      opened.intake,
    );
    // A file still being read when the dialog closed is refused, not added
    // to a decision already made.
    intake = null;
    await opened.settled();
    if (!decision) {
      // Cancelled: nothing is ingested. A half-applied batch is exactly the
      // surprise this dialog exists to remove.
      inventory.logSkipped(
        [...tableFiles, ...limitFiles].map((entry) => entry.file),
        'the Import dialog was cancelled',
      );
      host.say('area', [
        ...routed,
        `Import cancelled — none of the ${tableFiles.length + limitFiles.length} dropped file(s) ` +
          `were loaded.`,
      ]);
      host.render();
      return;
    }

    // Past the dialog the drop is a run of batches, each of which may open a
    // picker. The floor keeps the app looking busy between them.
    // A file taken out with × is the user's choice, not a refusal.
    const planned = new Set(decision.plans.map((plan, index) => plan.fileIndex ?? index));
    const plannedLimits = new Set(decision.limits.map((plan) => plan.fileIndex));
    inventory.logSkipped(
      [
        ...tableFiles.filter((_, index) => !planned.has(index)),
        ...limitFiles.filter((_, index) => !plannedLimits.has(index)),
      ].map((entry) => entry.file),
      'removed in the Import dialog',
    );
    everything = decision.everything;
    const fileCount = decision.plans.length + decision.limits.length;
    host.setBusyFloor(
      everything
        ? `Loading ${fileCount} file(s), keeping everything they carry…`
        : `Loading ${fileCount} file(s)… you may be asked what to keep.`,
    );

    // Plans pair with `tableFiles` by INDEX (`plan.fileIndex`), never by
    // filename: one drop may carry two files of the same name. `plan.kind` is
    // the FINAL kind, including a corrected misdetection. Each (kind, shape)
    // gets its own batch because each picker's answer is its own, and neither
    // reader can take the other's plans.
    const split = splitPlans(
      decision.plans.map((plan, index) => {
        const file = tableFiles[plan.fileIndex ?? index].file;
        return {
          name: file.name,
          kind: plan.kind,
          shape: plan.shape,
          // Area carries NO variant: `groupByCase` keys on `caseName \0 variant`,
          // so a variant would split the two halves of one year into two
          // tables that both attach at the one Area slot, the second silently
          // replacing the first.
          drop:
            plan.kind === 'area'
              ? { file, caseName: plan.caseName }
              : { file, caseName: plan.caseName, variant: plan.variant },
        };
      }),
    );
    routed.push(...split.bugs);
    for (const bug of split.bugs) inventory.noteDrop(bug);

    // Each kind ingests its own batch, and one failing does not skip another.
    // Each kind's channel is rewritten once per drop, even when the drop
    // carried none of that kind, so no note outlives the drop it describes.
    // `routed` is app-wide and rides with the area channel.
    // An engine runs only for a batch the drop carried; its structured
    // outcome is rendered here into the notes the user reads.
    const run = async (kind: TableKind, shape: 'W' | 'L') => {
      // A fresh array each, never a shared empty one: an engine that sorted
      // its batch in place would otherwise sort every other kind's too.
      const drops: Drop[] = (shape === 'W' ? split.wide : split.long).get(kind) ?? [];
      if (drops.length === 0) return [];
      const outcome = await host.ingest(kind, shape, drops);
      inventory.recordOutcome(outcome);
      return outcomeNotes(outcome);
    };
    const areaNotes = [
      ...routed,
      ...(await run('area', 'L')),
      // After the long batch, never interleaved: both widen the Area axis,
      // and each batch reindexes loaded cubes once.
      ...(await run('area', 'W')),
    ];
    // Published BEFORE the other kinds' batches: they render and can throw,
    // and this drop's account must not be lost or left showing the last one's.
    host.say('area', areaNotes);
    host.say('interface', await run('interface', 'W'));
    host.say('bus', [...(await run('bus', 'W')), ...(await run('bus', 'L'))]);
    host.say('generator', [...(await run('generator', 'W')), ...(await run('generator', 'L'))]);
    // AFTER every ingest: a pinned limits file resolves its Case by NAME, and
    // that Case may have just been created. Its notes republish the area
    // account, which stays correct either way.
    if (limitFiles.length > 0) {
      const limitNotes = await applyLimitDrops(
        decision.limits.map((plan) => ({ file: limitFiles[plan.fileIndex].file, plan })),
      );
      host.say('area', [...areaNotes, ...limitNotes]);
    }
    host.refreshCases();
    if (host.listCases().length > 0) host.revealDrawer();
    host.render();
  }

  /**
   * Take files into the open Import Dialog, appending them to `tableFiles`
   * and `limitFiles` so a plan's `fileIndex` finds them. Adds run one at a
   * time, in arrival order, so the numbering is the order the dialog sees.
   * Only a table or limits file joins: anything else applies session state
   * the open dialog would not show, so it is refused until the load ends.
   */
  function openIntake(
    tableFiles: Dropped[],
    limitFiles: Dropped[],
  ): { intake: ImportIntake; settled: () => Promise<void> } {
    let queue = Promise.resolve();
    let take: ((added: AddedFiles) => void) | null = null;
    let shows: (index: number) => boolean = () => true;
    let open = true;

    async function admit(files: File[]): Promise<void> {
      const classified = await classifyFiles(files);
      if (!open) {
        refuse(
          files,
          'These files arrived as the Import dialog closed — drop them again once the load finishes.',
        );
        return;
      }
      held.push(...files);
      const route = routeDrop(classified);
      const added: AddedFiles = { tables: [], limits: [], notes: [] };
      for (const step of route.auxiliary) {
        const file = step.item.file;
        const note =
          `${file.name}: only table and limits files join an open Import dialog — ` +
          'drop it again once this load finishes.';
        added.notes.push(note);
        inventory.logRefused([file], note);
      }
      // The same name and size as a file with a row is that file again.
      const same = (a: File, b: File) => a.name === b.name && a.size === b.size;
      // A file this add has taken is one with a row, though not shown yet.
      const join = (
        into: Dropped[],
        entries: RoutedFile<Dropped>[],
        has: (i: number) => boolean,
      ) => {
        const known = into.length;
        return entries.flatMap(({ item }) => {
          const repeat = into.some(
            (entry, index) => (index >= known || has(index)) && same(entry.file, item.file),
          );
          if (repeat) {
            const note = `${item.file.name}: already in this import — skipped.`;
            added.notes.push(note);
            inventory.logSkipped([item.file], 'already in the Import dialog');
            return [];
          }
          into.push(item);
          return [{ index: into.length - 1, file: item.classified }];
        });
      };
      added.tables = join(tableFiles, route.tables, (index) => shows(index));
      // A limits row has no ×, so every one still shows.
      added.limits = join(limitFiles, route.limits, () => true);
      take?.(added);
    }

    return {
      intake: {
        add(files) {
          // A file that cannot be read is refused alone; the queue goes on.
          queue = queue
            .then(() => admit(files))
            .catch((error) => refuse(files, `These files were not added: ${errorText(error)}.`));
        },
        listen(listener, showing) {
          take = listener;
          shows = showing;
        },
      },
      settled() {
        open = false;
        return queue;
      },
    };
  }

  /**
   * A name-keyed generator membership file and an area Groupings.csv look the
   * same, so the host asks rather than guessing. A cancelled question changes
   * nothing and says so.
   */
  async function applyGroupingsFile({ file, classified }: Dropped): Promise<string[]> {
    const text = await file.text();
    const choice = await host.askGroupings(file, text, classified.detected.writtenBy);
    if (choice === null) {
      inventory.logSkipped([file], 'the groupings mapping was cancelled');
      return [`${file.name}: groupings load cancelled — nothing was changed.`];
    }
    // Collected as they happen: a note already said stays said if a later
    // step throws.
    const out: string[] = [];
    try {
      const said = host.loadGroupings(choice, text, file.name);
      out.push(...said);
      // After the load, which throws on a file it refuses.
      inventory.recordSessionInput(
        groupsInput(choice.entity),
        [file],
        `${host.kindLabel(choice.entity)} groups`,
      );
      for (const note of said) inventory.noteFiles([file], note);
    } catch (error) {
      const refusal = `${file.name}: ${errorText(error)}`;
      out.push(refusal);
      inventory.logRefused([file], refusal);
    }
    return out;
  }

  async function applyLookupFile(file: File): Promise<string[]> {
    const out: string[] = [];
    try {
      const parsed = parseLookupCsv(await file.text(), file.name);
      const merged = host.attachLookup(parsed.rows, file.name);
      const said = [...parsed.warnings, merged.note];
      out.push(...said);
      // A list MERGES a second file into the first, so the row lists every
      // file that went into it. A key read twice keeps its first row, so the
      // file loaded only in part.
      const schema = schemaFor(parsed.rows.entity);
      const dropped = parsed.duplicates + merged.alreadyKnown;
      inventory.recordSessionInput(VARIANT_OF[schema.entity], [file], schema.label, {
        merge: true,
        ...(dropped === 0
          ? {}
          : {
              partial:
                `${dropped.toLocaleString()} row(s) with a key already read were ` +
                `dropped; the first copy of each was kept`,
            }),
      });
      for (const note of said) inventory.noteFiles([file], note);
    } catch (error) {
      const refusal = `${file.name}: ${errorText(error)}`;
      out.push(refusal);
      inventory.logRefused([file], refusal);
    }
    return out;
  }

  /**
   * Install a drop's limits files at the dialog's scope. A pinned file
   * resolves its Case by NAME, never `caseIdForName` (which would create an
   * empty Case for a run that failed to load); an unknown name is refused.
   * Every file says how many on-screen interfaces it matched: a whole file
   * matching nothing must be visible here, since an unmatched path is silent
   * on the chart.
   */
  async function applyLimitDrops(
    drops: readonly { file: File; plan: LimitPlan }[],
  ): Promise<string[]> {
    const out: string[] = [];
    for (const { file, plan } of drops) {
      let table: LimitTable;
      let warnings: string[];
      try {
        const parsed = parseLimitsCsv(await file.text(), file.name);
        out.push(...parsed.warnings);
        warnings = parsed.warnings;
        table = parsed.table;
      } catch (error) {
        const refusal = `${file.name}: ${errorText(error)}`;
        out.push(refusal);
        inventory.logRefused([file], refusal);
        continue;
      }
      const paths = table.byInterface.size;
      // Bound once: narrowing a union through a property access does not
      // survive the calls between the test and the use.
      const scope = plan.scope;
      if (scope.kind === 'all') {
        const replaced = host.setSharedLimits(table);
        // A second shared file replaces the first, as the store does.
        inventory.recordSessionInput(SHARED_LIMITS_INPUT, [file], 'Limits');
        const said =
          `${file.name}: ${paths.toLocaleString()} path limit(s), shared by every Case that ` +
          `has none of its own.` +
          (replaced === null ? '' : ` This REPLACED the shared limits from ${replaced}.`);
        out.push(said);
        for (const note of [...warnings, said]) inventory.noteFiles([file], note);
        for (const entry of host.listCases()) {
          const matches = host.limitMatchNotes(entry.id, caseLabel(entry));
          out.push(...matches);
          for (const note of matches) inventory.noteDrop(note);
        }
        continue;
      }
      const target = caseForName(host.listCases(), scope.caseName);
      if (target === undefined) {
        const refusal =
          `${file.name}: assigned to Case "${scope.caseName}", which is not loaded — the ` +
          `limits were NOT applied. Its export may have been refused; load them together.`;
        out.push(refusal);
        inventory.logRefused([file], refusal);
        continue;
      }
      const replaced = host.setCaseLimits(target.id, table);
      inventory.recordCaseFile(target.id, LIMITS_COLUMN, file, 'Limits');
      const said =
        `${file.name}: ${paths.toLocaleString()} path limit(s) for Case "${caseLabel(target)}" ` +
        `only.` +
        (replaced === null ? '' : ` This REPLACED that Case's limits from ${replaced}.`);
      out.push(said);
      for (const note of [...warnings, said]) inventory.noteFiles([file], note);
      const matches = host.limitMatchNotes(target.id, caseLabel(target));
      out.push(...matches);
      for (const note of matches) inventory.noteDrop(note);
    }
    return out;
  }

  return {
    load,
    running: () => inFlight,
    keepsEverything: () => everything,
  };
}
