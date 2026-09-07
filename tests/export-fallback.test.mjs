// The Firefox path: indexedDB.databases() does not exist, so the exporter has
// to probe the names it knows and must not leave the probed-but-absent ones
// behind as empty databases.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
    const file = (req.url || '/').split('?')[0] === '/' ? 'index.html' : (req.url || '').split('?')[0].slice(1);
    try {
        const body = await readFile(join(ROOT, file));
        res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
        res.end(body);
    } catch { res.writeHead(404).end('nope'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const failures = [];
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` -> ${detail}` : ''}`);
    if (!ok) failures.push(name);
};

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true });
// Hide the API before any page script runs, in both the scan and the export.
// Keep a private handle on the real implementation so the test can still see
// the true database list after hiding it from the page.
await context.addInitScript(() => {
    window.__realDatabases = IDBFactory.prototype.databases;
    delete IDBFactory.prototype.databases;
});
const page = await context.newPage();
page.on('pageerror', e => console.log('  [pageerror] ' + e.message));

// A clean origin, with the API missing: nothing to rescue, nothing created.
await page.goto(base);
await page.waitForTimeout(600);
check('no API + no data keeps the panel hidden', await page.locator('#rescue').isHidden());
const afterScan = await page.evaluate(async () => (await window.__realDatabases.call(indexedDB)).map(d => d.name));
check('probing an empty origin leaves no databases', afterScan.length === 0, afterScan.join(','));

// Now seed two of the four known names and confirm only those come out.
const CONN = 'conn-firefox';
await page.evaluate(async (connId) => {
    localStorage.setItem('mudix_v1', JSON.stringify({
        state: { connections: [{ id: connId, name: 'Aetolia' }], client: {} }, version: 21,
    }));
    const open = (name, upgrade) => new Promise((res, rej) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => upgrade(req.result);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
    const done = tx => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });

    const vfsName = 'mudix_vfs_' + connId;
    const vfs = await open(vfsName, db => db.createObjectStore(vfsName));
    let tx = vfs.transaction(vfsName, 'readwrite');
    tx.objectStore(vfsName).put(new TextEncoder().encode('profile bytes'), 'inode-1');
    await done(tx);
    vfs.close();

    const maps = await open('mudix_maps', db => db.createObjectStore('maps'));
    tx = maps.transaction('maps', 'readwrite');
    tx.objectStore('maps').put(new Uint8Array([9, 9, 9]).buffer, connId);
    await done(tx);
    maps.close();
    // Deliberately no mudix_logs and no mudix_folder_handles: both are probed.
}, CONN);

await page.reload();
await page.waitForSelector('#rescue:not([hidden])', { timeout: 5000 });
check('panel appears via probing', true);

const dl = page.waitForEvent('download');
await page.click('#dl');
const backup = JSON.parse(await readFile(await (await dl).path(), 'utf8'));

check('profile found by derived name', !!backup.indexedDB['mudix_vfs_' + CONN]);
check('maps found', !!backup.indexedDB['mudix_maps']);
check('absent databases are not invented',
    !backup.indexedDB['mudix_logs'] && !backup.indexedDB['mudix_folder_handles']);
check('profile bytes intact',
    Buffer.from(backup.indexedDB['mudix_vfs_' + CONN].stores['mudix_vfs_' + CONN].records[0].value.v, 'base64')
        .toString() === 'profile bytes');

const finalDbs = await page.evaluate(async () => (await window.__realDatabases.call(indexedDB)).map(d => d.name).sort());
check('probing created no empty databases',
    finalDbs.join(',') === ['mudix_maps', 'mudix_vfs_' + CONN].sort().join(','), finalDbs.join(','));

await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
