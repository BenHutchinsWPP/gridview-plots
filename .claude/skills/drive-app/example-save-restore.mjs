// .claude/skills/drive-app/example-save-restore.mjs
//
// Worked example: pin across kinds and Cases, save, restore twice into a
// fresh context, and print the Selected tab each time. See SKILL.md.
import { chromium, open, loadStudy, tab, pinRow, makeGroup, selectedRows, S } from './drive.mjs';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
// ---- session 1: build, pin, save
{
  const { page } = await open(browser);
  await loadStudy(page);
  await makeGroup(page, 'SAMPLE_Boundary', 2);
  await tab(page, 'Bus');
  await pinRow(page, 'SAMPLE_Summer', '90001');
  await pinRow(page, 'SAMPLE_Winter', '90003');
  await tab(page, 'Interface');
  await pinRow(page, 'SAMPLE_Winter', 'SAMPLE_P01');
  await tab(page, 'Interface Groups');
  await pinRow(page, 'SAMPLE_Summer', 'SAMPLE_Boundary');
  console.log('before save', JSON.stringify(await selectedRows(page), null, 0));
  await page.screenshot({ path: `${S}/57-1-before-save.png` });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save' }).click(),
  ]);
  await download.saveAs(`${S}/study.gvmb`);
  console.log('saved as', download.suggestedFilename());
}
// ---- session 2: fresh context, restore twice
{
  const { page } = await open(browser);
  for (const round of [1, 2]) {
    await page.setInputFiles('#file-input', [`${S}/study.gvmb`]);
    await page.waitForTimeout(2500);
    console.log(`restore ${round}`, JSON.stringify(await selectedRows(page), null, 0));
    console.log(
      'header',
      await page
        .locator('header, .topbar')
        .first()
        .innerText()
        .catch(() => ''),
    );
    await page.screenshot({ path: `${S}/57-restore-${round}.png` });
  }
}
await browser.close();
