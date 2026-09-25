// .claude/skills/drive-app/drive.mjs
//
// Playwright helpers for driving GridView Plots headless. See SKILL.md.
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
export async function loadStudy(page) {
  await page.setInputFiles('#file-input', [`${S}/data/SAMPLE_BusList.csv`]);
  await page.waitForTimeout(500);
  const files = ['A_BusLMP', 'B_BusLMP', 'A_InterfaceFlow', 'B_InterfaceFlow'];
  await page.setInputFiles(
    '#file-input',
    files.map((f) => `${S}/data/SAMPLE_CASE${f}.csv`),
  );
  await page.getByText('Assign each file individually').click();
  const inputs = page.locator('input.modal-filter:visible');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    await inputs.nth(i).fill(i % 2 === 0 ? 'SAMPLE_Summer' : 'SAMPLE_Winter');
    await inputs.nth(i).press('Tab');
  }
  await page.getByRole('button', { name: 'Load everything' }).click();
  await page.waitForFunction(() => /2 cases/.test(document.body.innerText), null, {
    timeout: 30000,
  });
  await idle(page);
}
export { chromium };
export async function tab(page, name) {
  const button = page.locator('.browse-tab', { hasText: new RegExp(`^${name}( \\(\\d+\\))?$`) });
  await page.waitForTimeout(300);
  if (!(await button.isVisible())) {
    await page.locator('#browse-handle').click();
    await button.waitFor({ state: 'visible' });
  }
  await button.click();
  await page.waitForTimeout(300);
}
/** Tick the drawer row whose text contains every one of `needles`. */
export async function pinRow(page, ...needles) {
  let row = page.locator('#browse-drawer .browse-row');
  for (const n of needles) row = row.filter({ hasText: n });
  await row.first().locator('input[type=checkbox]').check();
  await page.waitForTimeout(300);
}
export async function makeGroup(page, name, reversedIndex) {
  await tab(page, 'Interface Groups');
  await page.getByRole('button', { name: /Edit Groups/ }).click();
  await page.getByPlaceholder('New group…').fill(name);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  for (const p of ['SAMPLE_P01', 'SAMPLE_P02', 'SAMPLE_P03'])
    await page.getByText(p, { exact: true }).last().dblclick();
  if (reversedIndex !== undefined) await page.locator('.groups-mark').nth(reversedIndex).click();
  await page.getByRole('button', { name: 'Apply groups' }).click();
  await page.waitForTimeout(500);
}
export async function selectedRows(page) {
  await tab(page, 'Selected');
  return page.evaluate(() => {
    // Tabulator's header cells and row cells both open with the tick column.
    const heads = [...document.querySelectorAll('#browse-drawer .tabulator-col')].map((th) =>
      th.innerText.replace(/[▾▲▼\s]+$/, '').trim(),
    );
    // Only rows scrolled into view are in the DOM; the Selected tab is short.
    return [...document.querySelectorAll('#browse-drawer .browse-row')].map((tr) => {
      const cells = [...tr.querySelectorAll('.tabulator-cell')].map((td) => td.innerText.trim());
      const o = {};
      heads.forEach((h, i) => {
        if (h && ['Case', 'Kind', 'Entity', 'In scope', 'Average'].includes(h)) o[h] = cells[i];
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
  await page.waitForTimeout(800);
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
  const refs = [`SAMPLE_BusList${suffix}.csv`, `SAMPLE_GeneratorList${suffix}.csv`];
  await page.setInputFiles(
    '#file-input',
    refs.map((f) => `${S}/data/${f}`),
  );
  await page.waitForTimeout(800);
  const files = ['AreaLoad', 'BusLoad', 'GenEnergy', 'InterfaceFlow'];
  if (sharedArea) files.push('BusEnergy');
  await page.setInputFiles(
    '#file-input',
    files.map((f) => `${S}/data/SAMPLE_CASEA_${f}.csv`),
  );
  await page.getByText('Assign each file individually').click();
  const inputs = page.locator('input.modal-filter:visible');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    await inputs.nth(i).fill('SAMPLE_Summer');
    await inputs.nth(i).press('Tab');
  }
  await page.getByRole('button', { name: 'Load everything' }).click();
  await page.waitForFunction(() => /1 case/.test(document.body.innerText), null, {
    timeout: 30000,
  });
  await idle(page);
  // A key/group file cannot always say which kind it groups. When it cannot,
  // a pane asks, with Areas the default for Name,Grouping columns.
  await page.setInputFiles('#file-input', [`${S}/data/SAMPLE_Groupings.csv`]);
  await page.waitForTimeout(1000);
  const ask = page.locator('.modal-backdrop').getByRole('button', { name: 'Load', exact: true });
  if (await ask.isVisible()) await ask.click();
  await page.waitForTimeout(800);
}
/**
 * Edit one group in the shared membership editor, from its groups tab.
 * `create` names a new group; otherwise `group` is selected. `add` and
 * `remove` are text each item carries (a name, or a bus id). The three
 * `.groups-list` columns are groups, members, then the axis to add from.
 */
export async function editGroup(page, tabName, { group, create = false, add = [], remove = [] }) {
  await tab(page, tabName);
  await page.getByRole('button', { name: /Edit Groups/ }).click();
  const lists = page.locator('.modal-backdrop .groups-list');
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
  await page.locator('.modal-backdrop .btn-primary').click();
  await page.waitForTimeout(800);
}
/** Wait until no load is running. A drop made while one runs is refused
 * with "A load is already running", and `body.is-busy` is what says so. */
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
  await page.waitForTimeout(600);
  const refusal = pane.locator('.pane-banner-refusal');
  return (await refusal.count()) ? (await refusal.allInnerTexts()).join(' | ') : null;
}
/**
 * Drop `files` (names under data/) and assign every one to `caseName`, then
 * wait for the load. For a study none of the fixed loaders above builds.
 */
export async function loadCaseFiles(page, files, caseName = 'SAMPLE_Summer') {
  await idle(page);
  await page.setInputFiles(
    '#file-input',
    files.map((f) => `${S}/data/${f}`),
  );
  await page.getByText('Assign each file individually').click();
  const inputs = page.locator('input.modal-filter:visible');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    await inputs.nth(i).fill(caseName);
    await inputs.nth(i).press('Tab');
  }
  await page.getByRole('button', { name: 'Load everything' }).click();
  await page.waitForTimeout(800);
  await idle(page);
}
