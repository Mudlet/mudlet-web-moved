// Rescues everything the old Mudlet Web deployment stored on this origin.
//
// Browser storage is keyed per address, so moving to web.mudlet.org left every
// profile, script, map and log sitting here, reachable by nothing - the app that
// used to read them is not served at this address any more. This file is the way
// back out: it walks the origin's storage and writes it to one JSON file.
//
// It is deliberately a verbatim dump rather than a tidied, semantic export. The
// shapes below are internal to the app and keep changing; a faithful copy can
// always be replayed into whatever the importer needs later, while anything this
// file decided to summarise would be gone for good.

(function () {
    'use strict';

    var FORMAT = 'mudlet-web-backup';
    var FORMAT_VERSION = 1;

    // Databases this deployment created are all `mudix`-prefixed (the project's
    // pre-rename name, kept deliberately - see the note on storage keys in the
    // app's CLAUDE.md): `mudix_vfs_<connectionId>` per profile, plus mudix_maps,
    // mudix_logs and mudix_folder_handles.
    var OURS = /^mudix/;
    // localStorage is not so tidy - command history is stored under
    // `cmd.history.<connectionId>`, with no prefix at all. Rather than curate a
    // list that silently drops the next key someone adds, every localStorage key
    // is exported; this pattern only decides whether there is anything here
    // worth offering to rescue.
    var OURS_LOCAL = /^(mudix|cmd\.history)/;
    var LOGS_DB = 'mudix_logs';
    // Directory handles are live capability objects. They do not survive being
    // written to a file, and could not be re-granted on another origin even if
    // they did, so they are reported rather than exported.
    var HANDLES_DB = 'mudix_folder_handles';
    var OPEN_TIMEOUT_MS = 8000;

    var LABELS = {
        'mudix_maps': 'Maps',
        'mudix_logs': 'Session logs',
        'mudix_folder_handles': 'Linked folder permissions'
    };

    function label(name) {
        if (LABELS[name]) return LABELS[name];
        if (name.indexOf('mudix_vfs_') === 0) return 'Profile data';
        return name;
    }

    // ---------------------------------------------------------------- encoding

    var B64_CHUNK = 0x8000;

    function toBase64(bytes) {
        var out = '';
        for (var i = 0; i < bytes.length; i += B64_CHUNK) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
        }
        return btoa(out);
    }

    // Tagged encoding for the values IndexedDB hands back. Anything structured
    // clone can hold that JSON cannot is wrapped in a `$`-tagged object; plain
    // JSON values pass through untouched so the file stays readable.
    function encode(value, notes, path) {
        if (value === null) return null;
        var t = typeof value;
        if (t === 'string' || t === 'boolean') return value;
        if (t === 'number') return isFinite(value) ? value : { $: 'number', v: String(value) };
        if (t === 'undefined') return { $: 'undefined' };
        if (t === 'bigint') return { $: 'bigint', v: value.toString() };

        if (value instanceof Date) return { $: 'Date', v: value.toISOString() };
        if (value instanceof ArrayBuffer) {
            return { $: 'ArrayBuffer', v: toBase64(new Uint8Array(value)) };
        }
        if (ArrayBuffer.isView(value)) {
            var view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            return { $: 'View', ctor: value.constructor.name, v: toBase64(view) };
        }
        if (Array.isArray(value)) {
            return value.map(function (v, i) { return encode(v, notes, path + '[' + i + ']'); });
        }
        if (value instanceof Map) {
            var entries = [];
            value.forEach(function (v, k) {
                entries.push([encode(k, notes, path + '<key>'), encode(v, notes, path + '<value>')]);
            });
            return { $: 'Map', v: entries };
        }
        if (value instanceof Set) {
            var items = [];
            value.forEach(function (v) { items.push(encode(v, notes, path + '<item>')); });
            return { $: 'Set', v: items };
        }
        // Reading a Blob is asynchronous, and threading that through this
        // recursion would make every field of every record a promise. Nothing
        // this app stores is a Blob, so the case is reported instead of handled.
        if (typeof Blob !== 'undefined' && value instanceof Blob) {
            notes.push({ where: path, why: 'Blob values are not exported' });
            return { $: 'unsupported', kind: 'Blob' };
        }
        if (t === 'object') {
            var proto = Object.getPrototypeOf(value);
            if (proto === Object.prototype || proto === null) {
                var out = {};
                for (var k in value) {
                    if (Object.prototype.hasOwnProperty.call(value, k)) {
                        out[k] = encode(value[k], notes, path + '.' + k);
                    }
                }
                return out;
            }
            var kind = (value.constructor && value.constructor.name) || 'object';
            notes.push({ where: path, why: kind + ' cannot be exported' });
            return { $: 'unsupported', kind: kind };
        }
        notes.push({ where: path, why: t + ' cannot be exported' });
        return { $: 'unsupported', kind: t };
    }

    // -------------------------------------------------------------- IndexedDB

    /**
     * Open a database only if it already exists.
     *
     * `indexedDB.open` on an unknown name silently creates an empty database, so
     * a guessed name would leave litter behind on an origin we are trying to
     * leave clean. An upgrade event means it was not there: back out, and remove
     * what the call just made.
     */
    function openExisting(name) {
        return new Promise(function (resolve) {
            var req;
            try { req = indexedDB.open(name); } catch (e) { resolve(null); return; }
            var fresh = false;
            var settled = false;
            var timer = setTimeout(function () {
                // `onblocked`, usually: another tab still holds a connection.
                if (!settled) { settled = true; resolve(null); }
            }, OPEN_TIMEOUT_MS);
            function done(db) {
                if (settled) { if (db) db.close(); return; }
                settled = true;
                clearTimeout(timer);
                resolve(db);
            }
            req.onupgradeneeded = function () { fresh = true; };
            req.onerror = function () { done(null); };
            req.onsuccess = function () {
                var db = req.result;
                if (fresh) {
                    db.close();
                    try { indexedDB.deleteDatabase(name); } catch (e) { /* leave it */ }
                    done(null);
                    return;
                }
                done(db);
            };
        });
    }

    function requestValue(req) {
        return new Promise(function (resolve, reject) {
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function describeIndexes(store) {
        var out = [];
        for (var i = 0; i < store.indexNames.length; i++) {
            var idx = store.index(store.indexNames[i]);
            out.push({
                name: idx.name,
                keyPath: idx.keyPath,
                unique: idx.unique,
                multiEntry: idx.multiEntry
            });
        }
        return out;
    }

    async function dumpDatabase(name, notes) {
        var db = await openExisting(name);
        if (!db) {
            notes.push({ where: name, why: 'database could not be opened' });
            return null;
        }
        try {
            var storeNames = Array.prototype.slice.call(db.objectStoreNames);
            if (!storeNames.length) return { version: db.version, stores: {} };

            var tx = db.transaction(storeNames, 'readonly');
            var stores = {};
            for (var i = 0; i < storeNames.length; i++) {
                var sn = storeNames[i];
                var store = tx.objectStore(sn);
                // getAllKeys/getAll rather than a cursor: one round trip per
                // store instead of one per record, and the two results come back
                // in the same order.
                var keys = await requestValue(store.getAllKeys());
                var values = await requestValue(store.getAll());
                var records = [];
                for (var r = 0; r < values.length; r++) {
                    records.push({
                        key: encode(keys[r], notes, name + '/' + sn + '/key'),
                        value: encode(values[r], notes, name + '/' + sn + '/' + r)
                    });
                }
                stores[sn] = {
                    keyPath: store.keyPath,
                    autoIncrement: store.autoIncrement,
                    indexes: describeIndexes(store),
                    records: records
                };
            }
            return { version: db.version, stores: stores };
        } catch (err) {
            notes.push({ where: name, why: String((err && err.message) || err) });
            return null;
        } finally {
            db.close();
        }
    }

    /**
     * The names this app is known to use: the fixed three, plus one VFS
     * database per profile in the persisted profile list. Candidates only -
     * any of them may not exist.
     */
    function candidateNames() {
        var derived = ['mudix_maps', LOGS_DB, HANDLES_DB];
        try {
            var raw = localStorage.getItem('mudix_v1');
            var parsed = raw ? JSON.parse(raw) : null;
            var connections = (parsed && parsed.state && parsed.state.connections) || [];
            for (var c = 0; c < connections.length; c++) {
                if (connections[c] && connections[c].id) derived.push('mudix_vfs_' + connections[c].id);
            }
        } catch (e) { /* no profile list to read; the fixed names still apply */ }
        return derived;
    }

    /**
     * Every database this origin actually holds.
     *
     * `indexedDB.databases()` is the direct answer and is trusted whenever it
     * works - including when it answers "none", which is what a visitor who
     * never used the old client looks like. Firefox does not implement it, so
     * there the candidate names are probed one by one instead; a name that does
     * not exist is dropped (and un-created) by openExisting.
     */
    async function listDatabases() {
        if (typeof indexedDB.databases === 'function') {
            try {
                var list = await indexedDB.databases();
                var names = [];
                for (var i = 0; i < list.length; i++) {
                    if (list[i] && list[i].name && OURS.test(list[i].name)) names.push(list[i].name);
                }
                return names;
            } catch (e) { /* fall through to probing */ }
        }
        var candidates = candidateNames();
        var present = [];
        for (var c = 0; c < candidates.length; c++) {
            var db = await openExisting(candidates[c]);
            if (db) { db.close(); present.push(candidates[c]); }
        }
        return present;
    }

    /** Every localStorage key on this origin. Only this app ever wrote here, so
     *  taking the lot is both lossless and immune to a key being forgotten. */
    function localStorageKeys() {
        var keys = [];
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k) keys.push(k);
            }
        } catch (e) { /* storage blocked; nothing to export */ }
        return keys;
    }

    /** Of those, the ones that mean this browser actually used the old client. */
    function recognisedLocalKeys() {
        return localStorageKeys().filter(function (k) { return OURS_LOCAL.test(k); });
    }

    // ----------------------------------------------------------------- public

    async function scan() {
        var names = await listDatabases();
        var keys = recognisedLocalKeys();
        return {
            databases: names,
            localStorageKeys: keys,
            hasData: !!(names.length || keys.length)
        };
    }

    async function buildBackup(options) {
        var includeLogs = !!(options && options.includeLogs);
        var onProgress = (options && options.onProgress) || function () {};
        var notes = [];

        var backup = {
            format: FORMAT,
            version: FORMAT_VERSION,
            createdAt: new Date().toISOString(),
            origin: location.origin,
            userAgent: navigator.userAgent,
            localStorage: {},
            indexedDB: {},
            skipped: notes
        };

        onProgress('Reading settings…');
        var keys = localStorageKeys();
        for (var i = 0; i < keys.length; i++) {
            try {
                backup.localStorage[keys[i]] = localStorage.getItem(keys[i]);
            } catch (e) {
                notes.push({ where: 'localStorage/' + keys[i], why: String(e && e.message) });
            }
        }

        var names = await listDatabases();
        for (var n = 0; n < names.length; n++) {
            var name = names[n];
            if (name === HANDLES_DB) {
                notes.push({
                    where: name,
                    why: 'linked local folders are a browser permission rather than data - re-link the folder on the new address'
                });
                continue;
            }
            if (name === LOGS_DB && !includeLogs) {
                notes.push({ where: name, why: 'session logs were left out of this backup' });
                continue;
            }
            onProgress('Reading ' + label(name) + '…');
            var dump = await dumpDatabase(name, notes);
            if (dump) backup.indexedDB[name] = dump;
        }

        onProgress('Packing the file…');
        return backup;
    }

    function download(backup) {
        var json = JSON.stringify(backup);
        var blob = new Blob([json], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var stamp = new Date().toISOString().slice(0, 10);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'mudlet-web-backup-' + stamp + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Long enough for the browser to have taken the bytes; the object URL
        // pins the whole blob in memory until it is released.
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        return blob.size;
    }

    window.MudletWebExport = {
        scan: scan,
        build: buildBackup,
        download: download,
        label: label
    };
})();
