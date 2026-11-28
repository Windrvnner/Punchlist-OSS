import { spreadsheetFile } from './headingRow.mjs';

export const solar = { name: 'Solar checklist.ods', grid: [
  ['Area', 'Requirement', 'Owner'],
  ['Interconnection', 'Interconnection agreement executed; conditions to energization identified', 'AM'],
  ['Interconnection', 'Network upgrade costs allocated and capped', 'AM'],
  ['Equipment', 'Inverter supply / LTSA in place', 'SL'],
  ['Land', 'Site control covers the whole array and the gen-tie', 'PN'],
  ['Interconnection', 'interconnection agreement executed; conditions to energization identified.', 'AM'],
] };
export const general = { name: 'General.ods', grid: [
  ['Checklist item'], ['Insurance is in place'], ['Site control covers the whole array and the gen-tie'],
] };

export async function uploadSheet(page, { name, grid }, selector = '#cl-file') {
  const file = await spreadsheetFile(page, name, [{ name: 'Sheet1', grid }]);
  await page.setInputFiles(selector, file);
}
export const itemSheet = (name, rows) => ({ name: `${name}.ods`, grid: [['Item'], ...rows.map((text) => [text])] });

async function drop(page, target, name, contents) {
  await page.locator(target).evaluate((zone, [name, contents]) => {
    const data = new DataTransfer();
    data.items.add(new File([contents], name));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  }, [name, contents]);
}

const formats = (page, picker) => page.locator(picker).getAttribute('accept').then((value) => value.split(','));
const rejected = (page, name) => page.locator('#cl-error').filter({ hasText: `Could not read ${name}` }).waitFor();

export async function checkChecklistFileFormats(start, say) {
  const contents = 'Section,Item\nLand,Review the signed lease';
  for (const extension of ['xlsx', 'csv']) {
    const { ctx, page } = await start();
    try {
      await page.click('#u-menu');
      await page.click('#s-checklist-open');
      const shelf = await formats(page, '#fl-file');
      const dropName = `Dropped checklist.${extension}`;
      await drop(page, '#fl-drop', dropName, contents);
      await rejected(page, dropName);

      const wizard = await formats(page, '#cl-file');
      const pickerName = `Selected checklist.${extension}`;
      await page.setInputFiles('#cl-file', {
        name: pickerName, mimeType: 'application/octet-stream', buffer: Buffer.from(contents),
      });
      await rejected(page, pickerName);

      const innerDrop = `Dropped in wizard.${extension}`;
      await drop(page, '#cl-drop', innerDrop, contents);
      await rejected(page, innerDrop);
      say(`both checklist pickers and drop targets reject .${extension}`,
        !shelf.includes(`.${extension}`) && JSON.stringify(shelf) === JSON.stringify(wizard)
          && wizard.includes('.docx') && wizard.includes('.ods') && !page.errors.length);
    } finally {
      await ctx.close();
    }
  }
}

export async function checkEmptyChecklistShelf(start, say, read) {
  for (const [size, scheme] of [[[1280, 736], 'dark'], [[1024, 640], 'light']]) {
    const { ctx, page } = await start(size, scheme);
    const open = async () => {
      await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open');
      await page.click('#s-checklist-open'); await page.waitForSelector('#fl-import');
    };
    await open();
    const empty = await page.evaluate(() => {
      const zone = document.querySelector('#fl-drop'); const dialog = zone?.closest('.dlg');
      return {
        zone: zone?.offsetHeight, dialog: dialog?.offsetHeight,   // as laid out, not mid-way through the opening scale
        icon: !!zone?.querySelector('svg'), words: zone?.textContent.trim(),
        sections: document.querySelectorAll('.fl-sec').length, count: !!document.querySelector('#fl-count'),
      };
    });
    say(`no lists: one 160px drop area with the icon, in a dialog at least 360px tall (${size[0]})`,
      empty.zone === 160 && empty.dialog >= 360 && empty.icon
        && empty.words === 'Drop a checklist here, or choose a file…' && empty.sections === 0 && !empty.count,
      JSON.stringify(empty));
    await uploadSheet(page, solar, '#fl-file'); await page.waitForSelector('#cl-next'); await read(page);
    const opened = { title: await page.textContent('.imdlg h2'), source: await page.textContent('.imfile') };
    say(`a file chosen there opens Import a checklist with it read (${size[0]})`,
      opened.title === 'Import a Checklist' && opened.source.startsWith('Solar checklist.ods'), JSON.stringify(opened));
    // the import under way is kept: a second file on the empty dialog opens it as it was left, the choices in it kept
    await page.click('[data-layer=technology]'); await page.fill('#cl-name', 'Solar');
    await page.keyboard.press('Escape'); await page.waitForSelector('.imdlg', { state: 'detached' });
    await open(); await uploadSheet(page, general, '#fl-file'); await page.waitForSelector('#cl-next');
    const kept = { name: await page.inputValue('#cl-name'), source: await page.textContent('.imfile') };
    say(`an import under way is never replaced by a file dropped on the empty dialog (${size[0]})`,
      kept.name === 'Solar' && kept.source.startsWith('Solar checklist.ods'), JSON.stringify(kept));
    await page.click('#cl-next'); await page.waitForSelector('#cl-go'); await page.click('#cl-go');
    await page.waitForSelector('#fl-count');
    say(`with a list, the layers and the count come back (${size[0]})`,
      !(await page.$('#fl-drop')) && (await page.$$('.fl-sec')).length === 4, await page.textContent('#fl-count'));
    await page.click('#fl-import'); await page.waitForSelector('#cl-drop');
    const iconFirst = !!(await page.$('#cl-drop > svg + div'));
    say(`the import's own drop area has the icon above its words (${size[0]})`, iconFirst);
    say(`no errors on the page (${size[0]})`, page.errors.length === 0, JSON.stringify(page.errors));
    await ctx.close();
  }
}
