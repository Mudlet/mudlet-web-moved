// End-to-end check of the rescue exporter on the moved-notice page.
//
// Seeds an origin with storage shaped exactly like the old Mudlet Web
// deployment's (localStorage store blob, per-profile ZenFS VFS database holding
// Uint8Array files, mudix_maps holding an ArrayBuffer, mudix_logs with two
// stores and an index, and a folder-handle database), then drives the page and
// asserts what comes out of the download.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    const file = path === '/' ? 'index.html' : path.slice(1);
    try {
        const body = await readFile(join(ROOT, file));
        res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
        res.end(body);
    } catch {
        res.writeHead(404).end('nope');
    }
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
const page = await context.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('  [console] ' + m.text()); });
page.on('pageerror', e => console.log('  [pageerror] ' + e.message));

// --- a visitor with nothing stored -----------------------------------------
await page.goto(base);
await page.waitForTimeout(400);
check('panel stays hidden with no saved data', await page.locator('#rescue').isHidden());

// --- seed the origin --------------------------------------------------------
const CONN = 'conn-abc123';
await page.evaluate(async (connId) => {
    localStorage.setItem('mudix_v1', JSON.stringify({
        state: { connections: [{ id: connId, name: 'Achaea', host: 'achaea.com', port: 23 }], client: { theme: 'dark' } },
        version: 21,
    }));
    localStorage.setItem('mudix.debugGmcp', '1');
    // Command history has no mudix prefix - it was missed by the first cut.
    localStorage.setItem('cmd.history.' + connId, '["look"]');

    const open = (name, upgrade) => new Promise((res, rej) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => upgrade(req.result);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
    const done = tx => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });

    // Per-profile VFS: database and store share the name, values are Uint8Array.
    const vfsName = 'mudix_vfs_' + connId;
    const vfs = await open(vfsName, db => db.createObjectStore(vfsName));
    let tx = vfs.transaction(vfsName, 'readwrite');
    tx.objectStore(vfsName).put(new TextEncoder().encode('{"connectionScripts":["hi"]}'), 'inode-1');
    tx.objectStore(vfsName).put(new Uint8Array([0, 1, 2, 253, 254, 255]), 'inode-2');
    await done(tx);
    vfs.close();

    // Maps: out-of-line key, ArrayBuffer value.
    const maps = await open('mudix_maps', db => db.createObjectStore('maps'));
    tx = maps.transaction('maps', 'readwrite');
    tx.objectStore('maps').put(new Uint8Array([1, 2, 3, 4, 250]).buffer, connId);
    await done(tx);
    maps.close();

    // Logs: in-line keys, an index, and a Date field.
    const logs = await open('mudix_logs', db => {
        db.createObjectStore('sessions', { keyPath: 'id' });
        const e = db.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
        e.createIndex('sessionId', 'sessionId', { unique: false });
    });
    tx = logs.transaction(['sessions', 'entries'], 'readwrite');
    tx.objectStore('sessions').put({ id: 's1', startedAt: new Date('2026-01-02T03:04:05Z'), name: 'Achaea' });
    tx.objectStore('entries').put({ sessionId: 's1', text: 'You see a rat.', html: '<span>You see a rat.</span>' });
    await done(tx);
    logs.close();

    // Folder handles: a live capability object that cannot be exported.
    const handles = await open('mudix_folder_handles', db => db.createObjectStore('handles'));
    tx = handles.transaction('handles', 'readwrite');
    tx.objectStore('handles').put({ notARealHandle: true }, connId);
    await done(tx);
    handles.close();
}, CONN);

// --- the returning user -----------------------------------------------------
await page.reload();
await page.waitForSelector('#rescue:not([hidden])', { timeout: 5000 });
check('panel appears when data exists', true);
const found = await page.locator('#found li').allTextContents();
check('summary names one profile', found.some(t => /1 profile/.test(t)), found.join(' | '));
check('summary lists maps', found.some(t => /Maps/.test(t)), found.join(' | '));

// --- export without logs ----------------------------------------------------
let dl = page.waitForEvent('download');
await page.click('#dl');
const backup = JSON.parse(await readFile(await (await dl).path(), 'utf8'));

check('format tag', backup.format === 'mudlet-web-backup' && backup.version === 1);
check('localStorage captured', typeof backup.localStorage['mudix_v1'] === 'string'
    && backup.localStorage['mudix.debugGmcp'] === '1');
check('un-prefixed command history captured',
    backup.localStorage['cmd.history.' + CONN] === '["look"]',
    JSON.stringify(Object.keys(backup.localStorage)));
check('profile VFS database captured', !!backup.indexedDB['mudix_vfs_' + CONN]);
check('maps captured', !!backup.indexedDB['mudix_maps']);
check('logs excluded by default', !backup.indexedDB['mudix_logs']);
check('folder handles never exported', !backup.indexedDB['mudix_folder_handles']);
check('handle exclusion is reported',
    backup.skipped.some(s => s.where === 'mudix_folder_handles'));

const vfsStore = backup.indexedDB['mudix_vfs_' + CONN].stores['mudix_vfs_' + CONN];
const rec1 = vfsStore.records.find(r => r.key === 'inode-1');
const rec2 = vfsStore.records.find(r => r.key === 'inode-2');
check('VFS file round-trips as tagged base64',
    rec1.value.$ === 'View' && rec1.value.ctor === 'Uint8Array'
    && Buffer.from(rec1.value.v, 'base64').toString() === '{"connectionScripts":["hi"]}',
    JSON.stringify(rec1.value).slice(0, 120));
check('high bytes survive',
    Buffer.from(rec2.value.v, 'base64').equals(Buffer.from([0, 1, 2, 253, 254, 255])));

const mapRec = backup.indexedDB['mudix_maps'].stores['maps'].records[0];
check('map ArrayBuffer round-trips',
    mapRec.key === CONN && mapRec.value.$ === 'ArrayBuffer'
    && Buffer.from(mapRec.value.v, 'base64').equals(Buffer.from([1, 2, 3, 4, 250])),
    JSON.stringify(mapRec).slice(0, 120));

const status = await page.locator('#status').textContent();
check('status reports a saved size', /Saved \d/.test(status), status);

// --- export with logs -------------------------------------------------------
await page.check('#logs');
dl = page.waitForEvent('download');
await page.click('#dl');
const withLogs = JSON.parse(await readFile(await (await dl).path(), 'utf8'));
const logsDb = withLogs.indexedDB['mudix_logs'];
check('logs included when asked', !!logsDb);
check('log store schema captured',
    logsDb.stores.entries.keyPath === 'id' && logsDb.stores.entries.autoIncrement === true
    && logsDb.stores.entries.indexes[0].name === 'sessionId',
    JSON.stringify(logsDb.stores.entries).slice(0, 160));
const session = logsDb.stores.sessions.records[0].value;
check('Date round-trips', session.startedAt.$ === 'Date'
    && session.startedAt.v === '2026-01-02T03:04:05.000Z', JSON.stringify(session));
check('in-line key recorded', logsDb.stores.sessions.records[0].key === 's1');

// --- no litter left behind --------------------------------------------------
const dbs = await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name).sort());
check('no stray databases created', dbs.join(',') ===
    ['mudix_folder_handles', 'mudix_logs', 'mudix_maps', 'mudix_vfs_' + CONN].sort().join(','), dbs.join(','));

// --- the data is still there ------------------------------------------------
const stillThere = await page.evaluate(() => localStorage.getItem('mudix_v1') !== null);
check('export does not clear storage', stillThere);

await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
