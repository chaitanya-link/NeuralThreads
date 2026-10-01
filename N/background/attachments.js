/**
 * NeuralThreads - background/attachments.js (ES module, MV3 service worker)
 *
 * Downloads, validates and stores the photos + documents of a conversation.
 *
 * Why here: the service worker holds the extension's host permissions and is
 * not subject to the page's CORS rules, which is exactly what killed the
 * in-page canvas approach in v1.1.0.
 *
 * Pipeline per attachment (first success wins, every failure is recorded):
 *   1. Worker fetch of the URL (credentials included, host permissions).
 *   2. In-page fetch via the content script (blob:/data: URLs, same-origin cookies).
 *   3. Extra URL candidates from the platform's own API (Claude, ChatGPT).
 *   4. Documents only: text the platform already extracted (saved as .txt).
 * Then: reject HTML error pages, sniff the real type, fix the filename,
 * downscale oversized photos, and store one chrome.storage.local key per file.
 */

// ─── Limits ──────────────────────────────────────────────────────────────────

const MAX_ATTACHMENTS = 40;
const MAX_FILE_BYTES = 30 * 1024 * 1024;     // per file
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;   // per conversation
const IMG_MAX_EDGE = 2048;                   // downscale only above this...
const IMG_REENCODE_ABOVE = 3 * 1024 * 1024;  // ...or above this size
const CONCURRENCY = 3;

const KEY_PREFIX = 'nt_att:';
export const attachmentKey = (sessionId, id) => `${KEY_PREFIX}${sessionId}:${id}`;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * @param {Object} p
 * @param {string} p.platform   'claude' | 'chatgpt' | 'gemini'
 * @param {number} p.tabId      source tab (for in-page fetch fallback)
 * @param {string} p.tabUrl     source tab URL (conversation id lives here)
 * @param {Array}  p.refs       attachmentRefs from the content script
 * @param {string} p.sessionId  used to namespace storage keys
 * @returns {Promise<{attachments:Array, failures:Array, requested:number, notes:string[]}>}
 */
export async function captureAttachments({ platform, tabId, tabUrl, refs, sessionId }) {
    const notes = [];
    let items = (refs || []).map(normalizeRef);

    // Ask the platform's own API for files the DOM does not expose (documents!).
    try {
        const api = await discoverViaApi(platform, tabUrl, items);
        if (api.notes.length) notes.push(...api.notes);
        items = mergeItems(items, api.items);
    } catch (err) {
        notes.push(`API discovery skipped: ${err.message}`);
    }

    if (items.length > MAX_ATTACHMENTS) {
        notes.push(`Only the first ${MAX_ATTACHMENTS} of ${items.length} attachments are captured.`);
        items = items.slice(0, MAX_ATTACHMENTS);
    }

    const ctx = { platform, tabId, tabUrl, sessionId, totalBytes: 0 };
    const attachments = [];
    const failures = [];

    await runPool(items, CONCURRENCY, async (item, index) => {
        try {
            const saved = await captureOne(item, index, ctx);
            attachments[index] = saved;
        } catch (err) {
            failures[index] = {
                filename: item.filename || '(unnamed)',
                type: item.type,
                reason: err.message || String(err),
                host: hostOf(item.url),
            };
            console.warn(`[NeuralThreads] Attachment failed (${item.filename}):`, err.message);
        }
    });

    return {
        attachments: attachments.filter(Boolean),
        failures: failures.filter(Boolean),
        requested: items.length,
        notes,
    };
}

/** Remove the stored bytes for a session's attachments. */
export async function deleteAttachments(attachments) {
    const keys = (attachments || []).map((a) => a.key).filter(Boolean);
    if (keys.length) await chrome.storage.local.remove(keys);
}

// ─── One attachment ──────────────────────────────────────────────────────────

async function captureOne(item, index, ctx) {
    const errors = [];
    let got = null;

    const candidates = [];
    for (const u of [item.url, ...(item.altUrls || [])]) if (u && !candidates.includes(u)) candidates.push(u);

    // Candidates that need an API call to resolve (ChatGPT signed download URLs).
    if (typeof item.resolveUrls === 'function') {
        try {
            for (const u of await item.resolveUrls()) if (u && !candidates.includes(u)) candidates.push(u);
        } catch (err) {
            errors.push(`resolve: ${err.message}`);
        }
    }

    for (const url of candidates) {
        try {
            got = await fetchBytes(url, item, ctx);
            break;
        } catch (err) {
            errors.push(`${shortUrl(url)} → ${err.message}`);
        }
    }

    // Documents: fall back to the text the platform already extracted.
    if (!got && item.type === 'document' && item.fallbackText) {
        const text = String(item.fallbackText);
        const blob = new Blob([text], { type: 'text/plain' });
        got = { blob, mime: 'text/plain', derivedFromText: true };
        item = { ...item, filename: toTxtName(item.filename) };
    }

    if (!got) {
        if (errors.length) throw new Error(errors.join(' | ').slice(0, 300));
        throw new Error(item.type === 'document'
            ? 'document bytes are not exposed by this page (filename recorded only)'
            : 'no downloadable URL found');
    }

    let { blob } = got;
    if (blob.size === 0) throw new Error('empty file');
    if (blob.size > MAX_FILE_BYTES) throw new Error(`too large (${mb(blob.size)} MB; limit ${mb(MAX_FILE_BYTES)} MB)`);

    const sniffed = await sniffType(blob);
    rejectIfErrorPage(sniffed, item);

    let mime = pickMime(sniffed, got.mime, item.filename, item.mime);
    let filename = fixFilename(item.filename, mime, got.disposition, index);

    if (item.type === 'image' || mime.startsWith('image/')) {
        const scaled = await maybeDownscale(blob, mime);
        if (scaled.blob !== blob) {
            blob = scaled.blob;
            mime = scaled.mime;
            filename = swapExt(filename, 'jpg');
        }
    }

    if (ctx.totalBytes + blob.size > MAX_TOTAL_BYTES) {
        throw new Error(`conversation attachment budget reached (${mb(MAX_TOTAL_BYTES)} MB)`);
    }
    ctx.totalBytes += blob.size;

    const id = `${index}-${Math.random().toString(36).slice(2, 8)}`;
    const key = attachmentKey(ctx.sessionId, id);
    await chrome.storage.local.set({
        [key]: { filename, mime, size: blob.size, b64: await blobToBase64(blob) },
    });

    return {
        id,
        key,
        filename,
        mime,
        size: blob.size,
        type: mime.startsWith('image/') ? 'image' : 'document',
        messageIndex: item.messageIndex,
        role: item.role,
        derivedFromText: !!got.derivedFromText,
    };
}

// ─── Fetching ────────────────────────────────────────────────────────────────

async function fetchBytes(url, item, ctx) {
    // blob: URLs only exist inside the page that created them.
    if (/^blob:/i.test(url)) return inPage(url, ctx);

    if (/^data:/i.test(url)) {
        const res = await fetch(url);
        const blob = await res.blob();
        return { blob, mime: blob.type };
    }

    let workerErr = null;
    try {
        const headers = authHeadersFor(url, item);
        const res = await fetch(url, { credentials: 'include', redirect: 'follow', headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.startsWith('text/html') && !/\.html?$/i.test(item.filename || '')) {
            throw new Error('got a web page instead of a file (not signed in, or access blocked)');
        }
        const blob = await res.blob();
        return { blob, mime: ct.split(';')[0], disposition: res.headers.get('content-disposition') || '' };
    } catch (err) {
        workerErr = err;
    }

    // Fallback: same request from inside the page (page cookies, same-origin, blob/data).
    if (ctx.tabId != null && sameSite(url, ctx.tabUrl)) {
        try {
            return await inPage(url, ctx);
        } catch (err) {
            throw new Error(`${workerErr.message}; in-page: ${err.message}`);
        }
    }
    throw workerErr;
}

function inPage(url, ctx) {
    return new Promise((resolve, reject) => {
        if (ctx.tabId == null) return reject(new Error('no source tab for in-page fetch'));
        chrome.tabs.sendMessage(ctx.tabId, { type: 'NT_FETCH_IN_PAGE', url }, (res) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!res || !res.success) return reject(new Error(res?.error || 'in-page fetch failed'));
            try {
                const blob = base64ToBlob(res.b64, res.mime);
                resolve({ blob, mime: (res.mime || '').split(';')[0], disposition: res.disposition || '' });
            } catch (err) {
                reject(err);
            }
        });
    });
}

function authHeadersFor(url, item) {
    return item.authHeaders && item.authOrigin && url.startsWith(item.authOrigin) ? item.authHeaders : undefined;
}

// ─── Platform API discovery ──────────────────────────────────────────────────

async function discoverViaApi(platform, tabUrl, domItems) {
    if (platform === 'claude') return discoverClaude(tabUrl, domItems);
    if (platform === 'chatgpt') return discoverChatGPT(tabUrl);
    return { items: [], notes: [] }; // Gemini exposes no conversation API we can use
}

const UUID_RX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function getJson(url, init) {
    const res = await fetch(url, { credentials: 'include', ...init });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function discoverClaude(tabUrl, domItems) {
    const notes = [];
    const convId = (tabUrl.match(/claude\.ai\/chat\/([0-9a-f-]{36})/i) || [])[1];
    if (!convId) return { items: [], notes };

    // Organisation ids: prefer the one already visible in file URLs, else ask.
    const orgIds = new Set();
    for (const it of domItems) {
        const m = /\/api\/(?:organizations\/)?([0-9a-f-]{36})\/files\//i.exec(it.url || '');
        if (m) orgIds.add(m[1]);
    }
    if (orgIds.size === 0) {
        const orgs = await getJson('https://claude.ai/api/organizations');
        (Array.isArray(orgs) ? orgs : []).forEach((o) => o?.uuid && orgIds.add(o.uuid));
    }

    let convo = null;
    let org = null;
    for (const id of orgIds) {
        try {
            convo = await getJson(
                `https://claude.ai/api/organizations/${id}/chat_conversations/${convId}?tree=True&rendering_mode=messages&render_all_tools=true`
            );
            org = id;
            break;
        } catch (_) { /* try next org */ }
    }
    if (!convo) {
        notes.push('Claude conversation API not reachable; using what the page shows.');
        return { items: [], notes };
    }

    const abs = (u) => (u ? new URL(u, 'https://claude.ai').href : null);
    const items = [];
    const messages = Array.isArray(convo.chat_messages) ? convo.chat_messages : [];

    for (const msg of messages) {
        const files = (msg.files_v2 && msg.files_v2.length ? msg.files_v2 : msg.files) || [];
        const extractedByName = new Map();
        for (const a of msg.attachments || []) {
            if (a?.file_name && a.extracted_content) extractedByName.set(a.file_name, a.extracted_content);
        }
        const usedNames = new Set();

        for (const f of files) {
            const fileId = (f.file_uuid || f.uuid || '').toLowerCase();
            const name = f.file_name || f.name || 'file';
            const isImage = f.file_kind === 'image' || /^image\//i.test(f.file_type || '');
            const urls = isImage
                ? [f.preview_asset?.url, f.preview_url, f.thumbnail_asset?.url, f.thumbnail_url]
                : [
                    f.document_asset?.url,
                    // Unverified endpoint shapes — harmless if they 404, validated before saving.
                    fileId && `/api/${org}/files/${fileId}/contents`,
                    fileId && `/api/organizations/${org}/files/${fileId}/download`,
                ];
            usedNames.add(name);
            items.push({
                type: isImage ? 'image' : 'document',
                filename: name,
                fileId,
                url: abs(urls.find(Boolean)),
                altUrls: urls.filter(Boolean).slice(1).map(abs),
                fallbackText: isImage ? null : extractedByName.get(name) || null,
                origin: 'api',
            });
        }

        // Text-only attachments (pasted content, extracted docs with no file entry).
        for (const a of msg.attachments || []) {
            if (!a?.extracted_content || usedNames.has(a.file_name)) continue;
            items.push({
                type: 'document',
                filename: a.file_name || 'pasted-text.txt',
                url: null,
                altUrls: [],
                fallbackText: a.extracted_content,
                origin: 'api-text',
            });
        }
    }
    return { items, notes };
}

async function discoverChatGPT(tabUrl) {
    const notes = [];
    const m = /https:\/\/(chatgpt\.com|chat\.openai\.com)\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{36})/i.exec(tabUrl || '');
    if (!m) return { items: [], notes };
    const origin = `https://${m[1]}`;
    const convId = m[2];

    const session = await getJson(`${origin}/api/auth/session`);
    const token = session?.accessToken;
    if (!token) {
        notes.push('ChatGPT session token unavailable; using what the page shows.');
        return { items: [], notes };
    }
    const authHeaders = { Authorization: `Bearer ${token}` };
    const convo = await getJson(`${origin}/backend-api/conversation/${convId}`, { headers: authHeaders });

    const found = [];
    for (const node of Object.values(convo.mapping || {})) {
        const msg = node?.message;
        if (!msg) continue;
        const when = msg.create_time || 0;

        for (const a of msg.metadata?.attachments || []) {
            if (!a?.id) continue;
            const isImage = /^image\//i.test(a.mime_type || a.mimeType || '');
            found.push({ when, type: isImage ? 'image' : 'document', filename: a.name || a.id, mime: a.mime_type, fileId: a.id });
        }
        for (const part of Array.isArray(msg.content?.parts) ? msg.content.parts : []) {
            if (part && typeof part === 'object' && part.content_type === 'image_asset_pointer') {
                const id = String(part.asset_pointer || '').replace(/^(?:file-service|sediment):\/\//, '');
                if (id) found.push({ when, type: 'image', filename: `image-${id.replace(/^file[-_]/i, '').slice(-8)}`, fileId: id });
            }
        }
    }
    found.sort((a, b) => a.when - b.when);

    const items = found.map((f) => ({
        type: f.type,
        filename: f.filename,
        mime: f.mime,
        fileId: f.fileId,
        url: null,
        altUrls: [],
        origin: 'api',
        authOrigin: `${origin}/backend-api`,
        authHeaders,
        // Signed download URLs are minted on demand (two API generations exist).
        resolveUrls: async () => {
            const out = [];
            const endpoints = [
                `${origin}/backend-api/files/${f.fileId}/download`,
                `${origin}/backend-api/files/download/${f.fileId}?conversation_id=${convId}&inline=false`,
            ];
            for (const ep of endpoints) {
                try {
                    const j = await getJson(ep, { headers: authHeaders });
                    if (j?.download_url) out.push(j.download_url);
                } catch (_) { /* next */ }
            }
            return out;
        },
    }));
    return { items, notes };
}

// ─── Merge DOM refs with API items ───────────────────────────────────────────

function normalizeRef(r) {
    return {
        type: r.type === 'image' ? 'image' : 'document',
        url: r.url || null,
        altUrls: Array.isArray(r.altUrls) ? r.altUrls : [],
        filename: r.filename || '',
        fileId: r.fileId ? String(r.fileId).toLowerCase() : fileIdFromUrl(r.url),
        messageIndex: r.messageIndex,
        role: r.role,
        thumbUrl: r.thumbUrl,
        origin: 'dom',
    };
}

function fileIdFromUrl(u) {
    if (!u) return undefined;
    const uuid = UUID_RX.exec(u);
    if (uuid) return uuid[0].toLowerCase();
    const gpt = /[?&]id=(file[-_][A-Za-z0-9]+)/i.exec(u) || /\/(file[-_][A-Za-z0-9]+)/i.exec(u);
    return gpt ? gpt[1] : undefined;
}

/**
 * Combine what the DOM showed with what the API knows. Same file (by id, else
 * by type + filename) becomes ONE item that keeps the DOM position info and
 * gains the API's extra URLs / text fallback.
 */
function mergeItems(domItems, apiItems) {
    const out = domItems.map((d) => ({ ...d }));
    const byId = new Map();
    const byName = new Map();
    out.forEach((it, i) => {
        if (it.fileId) byId.set(it.fileId, i);
        if (it.filename) byName.set(`${it.type}:${it.filename.toLowerCase()}`, i);
    });

    for (const api of apiItems) {
        const idHit = api.fileId ? byId.get(String(api.fileId).toLowerCase()) : undefined;
        const nameHit = api.filename ? byName.get(`${api.type}:${api.filename.toLowerCase()}`) : undefined;
        const hit = idHit ?? nameHit;
        if (hit === undefined) {
            out.push(api);
            continue;
        }
        const dom = out[hit];
        const urls = [dom.url, ...(dom.altUrls || []), api.url, ...(api.altUrls || [])].filter(Boolean);
        dom.url = urls[0] || null;
        dom.altUrls = urls.slice(1).filter((u, i, a) => a.indexOf(u) === i);
        dom.fileId = dom.fileId || api.fileId;
        dom.fallbackText = dom.fallbackText || api.fallbackText;
        dom.resolveUrls = dom.resolveUrls || api.resolveUrls;
        dom.authHeaders = dom.authHeaders || api.authHeaders;
        dom.authOrigin = dom.authOrigin || api.authOrigin;
        dom.mime = dom.mime || api.mime;
        if (!dom.filename || /^image-?\d*$/i.test(dom.filename)) dom.filename = api.filename || dom.filename;
    }
    return out;
}

// ─── Type sniffing / validation / naming ─────────────────────────────────────

async function sniffType(blob) {
    const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const hex = (n) => Array.from(b.slice(0, n)).map((x) => x.toString(16).padStart(2, '0')).join('');
    const ascii = (s, e) => String.fromCharCode(...b.slice(s, e));
    if (hex(8) === '89504e470d0a1a0a') return { mime: 'image/png', kind: 'image' };
    if (hex(3) === 'ffd8ff') return { mime: 'image/jpeg', kind: 'image' };
    if (ascii(0, 4) === 'GIF8') return { mime: 'image/gif', kind: 'image' };
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image' };
    if (ascii(0, 2) === 'BM') return { mime: 'image/bmp', kind: 'image' };
    if (ascii(4, 8) === 'ftyp') {
        const brand = ascii(8, 12);
        if (/^(heic|heix|mif1|msf1|hevc)/i.test(brand)) return { mime: 'image/heic', kind: 'image' };
        if (/^avif/i.test(brand)) return { mime: 'image/avif', kind: 'image' };
    }
    if (ascii(0, 4) === '%PDF') return { mime: 'application/pdf', kind: 'pdf' };
    if (hex(4) === '504b0304') return { mime: 'application/zip', kind: 'zip' }; // docx/xlsx/pptx/zip
    if (hex(4) === 'd0cf11e0') return { mime: 'application/x-ole-storage', kind: 'ole' }; // legacy doc/xls/ppt
    const head = new TextDecoder().decode(b).trimStart().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) return { mime: 'text/html', kind: 'html' };
    if (head.startsWith('{"') && b.length) return { mime: 'application/json', kind: 'json' };
    return { mime: '', kind: 'unknown' };
}

const BINARY_EXT_RX = /\.(?:pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|zip|epub|heic)$/i;

function rejectIfErrorPage(sniffed, item) {
    if (sniffed.kind === 'html' && !/\.html?$/i.test(item.filename || '')) {
        throw new Error('server returned an HTML page instead of the file');
    }
    if (sniffed.kind === 'json' && (item.type === 'image' || BINARY_EXT_RX.test(item.filename || ''))) {
        throw new Error('server returned JSON instead of the file');
    }
}

const EXT_MIME = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', heic: 'image/heic', avif: 'image/avif',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    xml: 'application/xml', html: 'text/html', htm: 'text/html', rtf: 'application/rtf', zip: 'application/zip',
    epub: 'application/epub+zip', ipynb: 'application/json',
};
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/heic': 'heic', 'image/avif': 'avif', 'application/pdf': 'pdf' };

function extOf(name) {
    const m = /\.([A-Za-z0-9]{1,6})$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
}

function pickMime(sniffed, headerMime, filename, hintMime) {
    // Zip-container sniffing is ambiguous (docx/xlsx/pptx/zip): trust the extension for those.
    if (sniffed.kind === 'zip' || sniffed.kind === 'ole') {
        const byExt = EXT_MIME[extOf(filename)];
        if (byExt) return byExt;
    }
    if (sniffed.mime && sniffed.kind !== 'zip' && sniffed.kind !== 'ole') return sniffed.mime;
    if (headerMime && headerMime !== 'application/octet-stream' && headerMime !== 'binary/octet-stream') return headerMime;
    if (hintMime) return hintMime;
    return EXT_MIME[extOf(filename)] || sniffed.mime || 'application/octet-stream';
}

function sanitizeName(name) {
    return String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function fixFilename(name, mime, disposition, index) {
    let n = sanitizeName(name);
    const generic = !n || /^(?:image|file|attachment|document|download|uploaded image)-?\d*$/i.test(n);
    if (generic && disposition) {
        const dm = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
        if (dm) n = sanitizeName(decodeURIComponent(dm[1]));
    }
    if (!n) n = `attachment-${index + 1}`;
    const want = MIME_EXT[mime];
    const have = extOf(n);
    if (want && have !== want && !(want === 'jpg' && have === 'jpeg')) {
        // Real bytes say PNG but the label said nothing useful -> add/replace the extension.
        n = have && EXT_MIME[have] && EXT_MIME[have].startsWith(mime.split('/')[0]) ? swapExt(n, want) : `${n}.${want}`;
    }
    return n;
}

function swapExt(name, ext) {
    return /\.[A-Za-z0-9]{1,6}$/.test(name) ? name.replace(/\.[A-Za-z0-9]{1,6}$/, `.${ext}`) : `${name}.${ext}`;
}

function toTxtName(name) {
    const n = sanitizeName(name) || 'document';
    return /\.txt$/i.test(n) ? n : `${n}.extracted.txt`;
}

// ─── Photo downscaling ───────────────────────────────────────────────────────

async function maybeDownscale(blob, mime) {
    if (!mime.startsWith('image/') || mime === 'image/gif' || mime === 'image/svg+xml') return { blob, mime };
    try {
        const bmp = await createImageBitmap(blob);
        const edge = Math.max(bmp.width, bmp.height);
        if (blob.size <= IMG_REENCODE_ABOVE && edge <= IMG_MAX_EDGE) {
            bmp.close();
            return { blob, mime };
        }
        const scale = Math.min(1, IMG_MAX_EDGE / edge);
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; // JPEG has no alpha
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
        return out.size < blob.size ? { blob: out, mime: 'image/jpeg' } : { blob, mime };
    } catch (_) {
        return { blob, mime }; // undecodable (e.g. HEIC): keep the original bytes
    }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
}

function base64ToBlob(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

async function runPool(list, limit, worker) {
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
        while (next < list.length) {
            const i = next++;
            await worker(list[i], i);
        }
    });
    await Promise.all(runners);
}

function hostOf(u) {
    try { return u ? new URL(u).host : undefined; } catch (_) { return undefined; }
}
function shortUrl(u) {
    try { const x = new URL(u); return `${x.host}${x.pathname.slice(0, 40)}`; } catch (_) { return String(u).slice(0, 50); }
}
function sameSite(a, b) {
    try {
        const ha = new URL(a).hostname.split('.').slice(-2).join('.');
        const hb = new URL(b).hostname.split('.').slice(-2).join('.');
        return ha === hb;
    } catch (_) { return false; }
}
const mb = (n) => (n / 1048576).toFixed(1);
