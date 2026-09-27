// src/app/contents.ts
//
// The Contents panel's rows and columns, and its one open instance. Every
// registered kind is a column and every session-wide input a strip row,
// loaded or not: a blank cell shows both what a Case lacks and what the app
// can take. The root hands in its inventory and Case store; this holds only
// which panel is open.

import {
  groupsInput,
  LIMITS_COLUMN,
  SHARED_LIMITS_INPUT,
  type Inventory,
  type InventoryCase,
  type InventoryColumn,
  type SessionRow,
} from '../inventory/store';
import { LIMITS_ENABLES } from '../limits/store';
import { LIST_SCHEMAS } from '../lookups/schema';
import { VARIANT_OF } from '../lookups/types';
import { byCaseName, caseLabel, type CaseStore } from '../model/case-model';
import { GROUPS_ENABLES, KIND_ENABLES, TABLE_KINDS } from '../tables/registry';
import type { ContentsSource } from '../ui/contents-panel';

/** A kind as a column or row heading. */
export function kindLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Limits come last, and a Case with none of its own reads `shared` when the
 * shared file serves it. */
function contentsColumns(): InventoryColumn[] {
  return [
    ...TABLE_KINDS.map((kind) => ({
      kind,
      label: kindLabel(kind),
      enables: KIND_ENABLES[kind],
    })),
    {
      kind: LIMITS_COLUMN,
      label: 'Limits',
      enables: LIMITS_ENABLES,
      fallback: { input: SHARED_LIMITS_INPUT, label: 'shared' },
    },
  ];
}

function contentsSessionRows(): SessionRow[] {
  return [
    ...LIST_SCHEMAS.map((schema) => ({
      input: VARIANT_OF[schema.entity],
      label: schema.label,
      enables: schema.enables,
    })),
    { input: SHARED_LIMITS_INPUT, label: 'Limits (shared)', enables: LIMITS_ENABLES },
    ...TABLE_KINDS.map((kind) => ({
      input: groupsInput(kind),
      label: `${kindLabel(kind)} groups`,
      enables: GROUPS_ENABLES[kind],
    })),
  ];
}

export interface ContentsHost {
  inventory: Inventory;
  cases: Pick<CaseStore, 'listCases' | 'setDisplayName'>;
  render(): void;
  /** Whether a load is running, which makes the About note read-only. */
  loading(): boolean;
  show(source: ContentsSource): { close(): void };
}

export function createContents(host: ContentsHost) {
  const { inventory, cases } = host;
  let panel: { close(): void } | null = null;

  /** The pivot's rows, in the order every Case list uses. */
  const contentsCases = (): InventoryCase[] =>
    cases
      .listCases()
      .slice()
      .sort(byCaseName)
      .map((entry) => ({
        id: entry.id,
        name: caseLabel(entry),
        ...(caseLabel(entry) === entry.name ? {} : { original: entry.name }),
        color: entry.color,
      }));

  /** Close the panel if it is open. Called when a load starts, so the panel
   * never shows a study half-way through changing. */
  function close(): void {
    panel?.close();
    panel = null;
  }

  function open(): void {
    close();
    panel = host.show({
      strip: () => inventory.strip(contentsSessionRows()),
      pivot: () => inventory.pivot(contentsCases(), contentsColumns()),
      detail: (recordId) => inventory.detail(recordId),
      log: () =>
        inventory.log({
          cases: cases.listCases().map((entry) => ({ id: entry.id, name: caseLabel(entry) })),
          columns: contentsColumns(),
          rows: contentsSessionRows(),
        }),
      tsv: () => inventory.tsv(contentsCases(), contentsColumns(), contentsSessionRows()),
      renameCase: (caseId, text) => {
        try {
          cases.setDisplayName(caseId, text);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        host.render();
        return undefined;
      },
      about: () => inventory.about(),
      setAbout: (text) => inventory.setAbout(text),
      loading: host.loading,
    });
  }

  return { open, close };
}
