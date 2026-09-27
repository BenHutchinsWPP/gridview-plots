// .claude/skills/drive-app/drive.mjs
//
// Playwright helpers for driving GridView Plots headless. See SKILL.md.
// Every wait is on something the app shows (`body.is-busy`, a dialog, a tab
// turning active, the pin count), so a slow load waits longer instead of
// racing a fixed sleep.
import { chromium } from 'playwright';
// Where the invented CSVs, screenshots and saved bundles live: the session
// scratchpad, passed as GV_WORK, never the repo.
export const S = process.env.GV_WORK ?? process.cwd();
export async function open(browser) {
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    delete window.showSaveFilePicker;
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(process.env.GV_URL ?? 'http://localhost:5199/');
  return { context, page };
}
/**
 * Drop `files` (names under data/), give file `i` to Case `caseOf(i)` in the
 * import dialog, and wait for the load to finish. The dialog sorts its rows
 * by detected kind, so each box is found by its file's label, not its place.
 * A lookup or limits file in the drop has no Case box and is left as is.
 */
async function loadIntoCases(page, files, caseOf) {
  await idle(page);
  await page.setInputFiles(
    '#file-input',
    files.map((f) => `${S}/data/${f}`),
  );
  // The dialog builds every row before it shows, so once this is clickable
  // a file with no box has none to wait for.
  await page.getByText('Assign each file individually').click();
  for (const [i, f] of files.entries()) {
    const input = page.getByLabel(`Case for ${f.split('/').pop()}`, { exact: true });
    if ((await input.count()) === 0) continue;
    await input.fill(caseOf(i));
    await input.press('Tab');
  }
  await page.getByRole('button', { name: 'Load everything' }).click();
  await idle(page);
}
/** Drop lookup-only files, which open no dialog, and wait for the load. */
async function loadLookups(page, files) {
  await idle(page);
  await page.setInputFiles(
    '#file-input',
    files.map((f) => `${S}/data/${f}`),
  );
  await idle(page);
}
export async function loadStudy(page) {
  await loadLookups(page, ['SAMPLE_BusList.csv']);
  const files = ['A_BusLMP', 'B_BusLMP', 'A_InterfaceFlow', 'B_InterfaceFlow'];
  await loadIntoCases(
    page,
    files.map((f) => `SAMPLE_CASE${f}.csv`),
    (i) => (i % 2 === 0 ? 'SAMPLE_Summer' : 'SAMPLE_Winter'),
  );
}
export { chromium };
/** A tab button's text: its name, then a count on the Selected tab. */
const tabLabel = (name) =>
  new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\(\\d+\\))?$`);
export async function tab(page, name) {
  const label = tabLabel(name);
  const button = page.locator('.browse-tab', { hasText: label });
  // The drawer's detent is settled by the time a load ends, so after idle()
  // a closed drawer stays closed until the handle opens it.
  await idle(page);
  if ((await page.locator('#browse-drawer').getAttribute('data-detent')) === 'closed') {
    await page.locator('#browse-handle').click();
  }
  await button.click();
  await page.locator('.browse-tab.active', { hasText: label }).waitFor();
}
/** The Selected tab's button once it reads `Selected (n)`. */
const selectedTab = (page, n) =>
  page.locator('.browse-tab', { hasText: new RegExp(`^Selected \\(${n ?? '\\d+'}\\)$`) });
/** How many rows are pinned, from the Selected tab's label. */
async function pinnedCount(page) {
  return Number((await selectedTab(page).textContent()).match(/\d+/)[0]);
}
/** Tick the drawer row whose text contains every one of `needles`. */
export async function pinRow(page, ...needles) {
  let row = page.locator('#browse-drawer .browse-row');
  for (const n of needles) row = row.filter({ hasText: n });
  const box = row.first().locator('input[type=checkbox]');
  if (await box.isChecked()) return;
  const before = await pinnedCount(page);
  await box.check();
  try {
    await selectedTab(page, before + 1).waitFor();
  } catch {
    throw new Error(`ticking the row with ${needles.join(', ')} left Selected at ${before}`);
  }
}
/**
 * Edit one group in the shared membership editor, from its groups tab.
 * `create` names a new group; otherwise `group` is selected. `add` and
 * `remove` are text each item carries (a name, or a bus id). The three
 * `.groups-list` columns are groups, members, then the axis to add from.
 * `beforeApply` runs with the edits made and the modal still open, for a
 * control only one kind's editor has.
 */
export async function editGroup(
  page,
  tabName,
  { group, create = false, add = [], remove = [] },
  beforeApply,
) {
  await tab(page, tabName);
  await page.getByRole('button', { name: /Edit Groups/ }).click();
  const modal = page.locator('.modal-backdrop');
  const lists = modal.locator('.groups-list');
  if (create) {
    await page.getByPlaceholder('New group…').fill(group);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
  } else {
    await lists.nth(0).locator('.groups-item', { hasText: group }).first().click();
  }
  for (const name of add)
    await lists.nth(2).locator('.groups-item', { hasText: name }).first().dblclick();
  for (const name of remove)
    await lists.nth(1).locator('.groups-item', { hasText: name }).first().dblclick();
  if (beforeApply) await beforeApply(modal);
  await modal.locator('.btn-primary').click();
  await modal.waitFor({ state: 'detached' });
  await idle(page);
}
export async function makeGroup(page, name, reversedIndex) {
  const add = ['SAMPLE_P01', 'SAMPLE_P02', 'SAMPLE_P03'];
  await editGroup(page, 'Interface Groups', { group: name, create: true, add }, (modal) =>
    reversedIndex === undefined
      ? undefined
      : modal.locator('.groups-mark').nth(reversedIndex).click(),
  );
}
export async function selectedRows(page) {
  await tab(page, 'Selected');
  // The tab turns active with its columns up and its rows still loading;
  // the grid holds `data-loading` until they land.
  await page.waitForFunction(() => !document.querySelector('#browse-drawer [data-loading]'));
  return page.evaluate(() => {
    // Tabulator's header cells and row cells both open with the tick column.
    // A header's first line is its name: the Selected tab's Case, Variable and
    // Unit headers carry the "Switch all" control under it.
    const heads = [...document.querySelectorAll('#browse-drawer .tabulator-col')].map((th) =>
      th.innerText
        .trim()
        .split('\n')[0]
        .replace(/[▾▲▼\s]+$/, '')
        .trim(),
    );
    // Only rows scrolled into view are in the DOM; the Selected tab is short.
    return [...document.querySelectorAll('#browse-drawer .browse-row')].map((tr) => {
      const cells = [...tr.querySelectorAll('.tabulator-cell')].map(
        // A row's own switch is a select: its value is the picked option.
        (td) => td.querySelector('select')?.selectedOptions[0]?.text ?? td.innerText.trim(),
      );
      const o = {};
      heads.forEach((h, i) => {
        if (h && ['Case', 'Kind', 'Entity', 'Drawn', 'Average'].includes(h)) o[h] = cells[i];
      });
      return o;
    });
  });
}
/**
 * Drop one interface limit schedule and assign it. `caseName` null shares it
 * with every Case; a name gives it to that Case only. A limits-only drop still
 * opens the import dialog, with one "Applies to" select per limits file.
 */
export async function loadLimits(page, file, caseName = null) {
  await idle(page);
  await page.setInputFiles('#file-input', [`${S}/data/${file}`]);
  const select = page.locator('.modal-backdrop select.modal-filter').last();
  await select.waitFor({ state: 'visible' });
  if (caseName !== null) await select.selectOption(caseName);
  await page.getByRole('button', { name: 'Load everything' }).click();
  await idle(page);
}
/** The saved bundle's manifest: bytes 0-3 `GVMB`, 4-7 its length (LE). */
export async function manifestOf(path) {
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(path);
  return JSON.parse(bytes.subarray(8, 8 + bytes.readUInt32LE(4)).toString('utf8'));
}
/**
 * One Case, SAMPLE_Summer, holding a table of every kind that has groups,
 * plus the BusList, GeneratorList and Groupings those groups key off.
 */
export async function loadGroupStudy(page, { sharedArea = false } = {}) {
  // `sharedArea` swaps in the lists whose units and buses sit inside the
  // area export's own areas, which is what the stack overlap check needs.
  const suffix = sharedArea ? '_SharedArea' : '';
  await loadLookups(page, [`SAMPLE_BusList${suffix}.csv`, `SAMPLE_GeneratorList${suffix}.csv`]);
  const files = ['AreaLoad', 'BusLoad', 'GenEnergy', 'InterfaceFlow'];
  if (sharedArea) files.push('BusEnergy');
  await loadIntoCases(
    page,
    files.map((f) => `SAMPLE_CASEA_${f}.csv`),
    () => 'SAMPLE_Summer',
  );
  // A key/group file cannot always say which kind it groups. When it cannot,
  // a pane asks, with Areas the default for Name,Grouping columns. The drop
  // stays busy while the pane is open, so wait for the pane or the end.
  await page.setInputFiles('#file-input', [`${S}/data/SAMPLE_Groupings.csv`]);
  const ask = page.locator('.modal-backdrop').getByRole('button', { name: 'Load', exact: true });
  await ask.or(page.locator('body:not(.is-busy)')).first().waitFor({ timeout: 60000 });
  if (await ask.isVisible()) await ask.click();
  await idle(page);
}
/** Wait until no load is running. A drop made while one runs is refused
 * with "A load is already running", and `body.is-busy` is what says so.
 * A drop sets it synchronously, so idle() straight after `setInputFiles`
 * waits for that drop, including while its dialog is open. */
export async function idle(page) {
  await page.waitForFunction(() => !document.body.classList.contains('is-busy'), null, {
    timeout: 60000,
  });
}
/**
 * Put chart slot `n` (1-4) on the stacked chart and report what it shows:
 * the refusal banner's text, or null when it drew a stack. Screenshot the
 * pane as well, because a stack that drew is only visible in pixels.
 */
export async function stackedSlot(page, n = 4) {
  const pane = page.locator('.pane', { has: page.locator(`[data-el="slot-type-${n}"]`) });
  await pane.locator(`[data-el="slot-type-${n}"]`).selectOption('stacked');
  const refusal = pane.locator('.pane-banner-refusal');
  await refusal.or(pane.locator('canvas:visible')).first().waitFor();
  return (await refusal.count()) ? (await refusal.allInnerTexts()).join(' | ') : null;
}
/**
 * Drop `files` (names under data/) and assign every one to `caseName`, then
 * wait for the load. For a study none of the fixed loaders above builds.
 */
export async function loadCaseFiles(page, files, caseName = 'SAMPLE_Summer') {
  await loadIntoCases(page, files, () => caseName);
}
