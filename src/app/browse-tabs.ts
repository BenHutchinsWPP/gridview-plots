// src/app/browse-tabs.ts
//
// Which browse tabs are on the bar, and the signature that says when they are
// stale. The drawer keeps built tabs until that signature moves, so a
// freshness input it misses leaves a silently stale ranking on screen. Hence
// nothing is positional: a declared tab brings its own scope signature, and
// app-wide inputs are one named record.
//
// DECLARED IS NOT SHOWN: every kind declares a tab on every render and empty
// ones are filtered afterwards, but the signature covers ALL of them, so a
// kind losing its last table still changes it.

/** What the drawer's variable dropdown reads for a tab, and what says whether
 *  the tab has anything to list. */
export interface BrowseTabScope {
  readonly tables: readonly unknown[];
  readonly variables: readonly string[];
  readonly variable: string;
  /** Moves exactly when a rebuild of this tab would differ. */
  readonly signature: string;
}

/** One tab and the scope it reads. The scope travels WITH the tab: an
 * if-chain over ids would hand an unknown id to its last branch's scope. */
export interface DeclaredTab<B> {
  readonly id: string;
  readonly label: string;
  readonly scope: BrowseTabScope;
  readonly build: B;
  /** Carried to the drawer as declared (`BrowseTabSource.offersRange`). */
  readonly offersRange?: boolean;
}

export interface CollectedTabs<B> {
  /** With something to list, in declaration order. */
  readonly tabs: {
    readonly id: string;
    readonly label: string;
    readonly build: B;
    readonly offersRange?: boolean;
  }[];
  readonly signature: string;
  /** The scope the variable dropdown reads: the preferred tab's if it is on
   *  the bar, else the first tab's, else nothing. */
  readonly shown: BrowseTabScope | undefined;
  /** The id whose scope `shown` is, or `''` when the bar is empty. */
  readonly activeId: string;
}

/**
 * @param declared Every tab, including kinds with nothing loaded.
 * @param shared App-wide freshness inputs no tab's own scope covers.
 * @param preferredId The tab the drawer is showing, if still on the bar.
 */
export function collectBrowseTabs<B>(
  declared: readonly DeclaredTab<B>[],
  shared: Readonly<Record<string, string | number>>,
  preferredId: string,
): CollectedTabs<B> {
  const parts: string[] = [];
  for (const tab of declared) parts.push(`${tab.id}=${tab.scope.signature}`);
  // Sorted, so reordering the record's fields is not a cache miss.
  for (const key of Object.keys(shared).sort()) parts.push(`${key}=${shared[key]}`);

  const tabs = declared.filter((tab) => tab.scope.tables.length > 0);
  const preferred = tabs.find((tab) => tab.id === preferredId);
  const active = preferred ?? tabs[0];

  return {
    tabs: tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      build: tab.build,
      ...(tab.offersRange ? { offersRange: true } : {}),
    })),
    signature: parts.join(' :: '),
    shown: active?.scope,
    activeId: active?.id ?? '',
  };
}
