/** Open a worksheet already in local import storage, using the browser's sheet reader for the fixture. */
export async function openKeptChecklist(page, name, sheets, { failures = {}, mapping } = {}) {
  await page.evaluate(async ({ name, sheets, mapping }) => {
    window.__sheets = { [name]: sheets };
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const read = await store.services.sheets.read(bytes, name, { headerRow: 1 });
    if (!read.ok) throw new Error(read.error.message);
    const table = { ...read.value, bytes, name };
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('dil-kept-imports', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('parts', 'readwrite');
        const parts = tx.objectStore('parts');
        parts.delete(IDBKeyRange.bound(['checklist'], ['checklist', []]));
        parts.put(table, ['checklist', 'table']);
        if (mapping) {
          const choices = {
            mapping, layer: 'broad', name: '', askReword: store.get().can.reword, askSame: true,
            shown: false, askedFor: '', byColumns: false, readFailed: '',
            bringIn: new Set(), useReword: new Set(), remove: new Set(),
          };
          parts.put(choices, ['checklist', 'choices']);
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  }, { name, sheets, mapping });
  await page.reload();
  await page.click('#u-menu');
  await page.evaluate(({ name, sheets, failures }) => {
    window.__sheets = { [name]: sheets };
    window.__fail = failures;
  }, { name, sheets, failures });
  await page.click('#s-checklist-open');
  await page.click('#fl-import');
}
