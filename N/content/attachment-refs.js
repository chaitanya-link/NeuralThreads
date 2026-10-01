/**
 * NeuralThreads - content/attachment-refs.js
 *
 * Shared helper loaded BEFORE content.js and the per-platform scrapers.
 * Exposes window.NeuralThreadsAttachments.
 *
 * Why this exists (the v1.1.0 failure):
 *   The old scrapers tried to read image pixels inside the page (Image +
 *   canvas.toDataURL). Attachments live on CDNs without CORS headers, so the
 *   canvas was tainted and every capture failed silently.
 *
 * What it does now:
 *   - collectRefs(): SYNCHRONOUS, reads no bytes. It only returns lightweight
 *     references { type, url, altUrls, filename, ... } for photos AND documents.
 *     The background service worker (which has host permissions and is not
 *     subject to page CORS) downloads the actual bytes.
 *   - inPageFetch(): used only as a fallback by the background worker for
 *     blob:/data: URLs (which only exist inside the page's own origin) and for
 *     same-origin URLs that need the page's cookies.
 *   - base64ToFile(): rebuilds a File from stored base64 at inject time.
 */
(function () {
    'use strict';

    if (window.NeuralThreadsAttachments) return;

    // ─── Constants ────────────────────────────────────────────────────────────

    const DOC_EXTENSIONS =
        'pdf|docx?|dotx?|xlsx?|xlsm|csv|tsv|pptx?|potx?|txt|md|markdown|rtf|odt|ods|odp|json|jsonl|xml|ya?ml|html?|zip|epub|ipynb|' +
        'py|js|jsx|ts|tsx|java|c|cc|cpp|h|hpp|cs|go|rs|rb|php|sql|sh|log|tex|srt|vtt';
    const IMAGE_EXTENSIONS = 'png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?';

    // A whole string that is a plain filename ("report final.pdf").
    const FILENAME_ONLY_RX = new RegExp(`^[^\\n\\\\/:*?"<>|]{1,140}\\.(?:${DOC_EXTENSIONS})$`, 'i');
    // A filename found anywhere inside a longer string.
    const FILENAME_IN_TEXT_RX = new RegExp(`([^\\s\\n\\\\/:*?"<>|][^\\n\\\\/:*?"<>|]{0,138}\\.(?:${DOC_EXTENSIONS}))(?![A-Za-z0-9])`, 'i');
    const DOC_URL_RX = new RegExp(`\\.(?:${DOC_EXTENSIONS})(?:[?#]|$)`, 'i');
    const IMAGE_URL_RX = new RegExp(`\\.(?:${IMAGE_EXTENSIONS})(?:[?#]|$)`, 'i');

    // Page chrome we never want to treat as a user attachment.
    const JUNK_IMG_HINT_RX = /avatar|emoji|favicon|logo|sprite|spinner|loading|profile|gravatar|brand|badge|tracking|pixel/i;
    const JUNK_ANCESTOR_SELECTOR =
        'nav, header, footer, [role="navigation"], [data-testid*="avatar" i], [class*="avatar" i], [class*="emoji" i], ' +
        '[class*="citation" i], [class*="source-chip" i], [class*="favicon" i]';

    // Elements that typically wrap a file "chip"/card in a message.
    const DEFAULT_CHIP_SELECTOR = [
        '[data-testid*="file" i]',
        '[data-test-id*="file" i]',
        '[data-testid*="attachment" i]',
        '[class*="file-chip" i]',
        '[class*="file-card" i]',
        '[class*="file-tile" i]',
        '[class*="file-preview" i]',
        '[class*="FileThumbnail" i]',
        '[class*="attachment" i]',
        'user-query-file-preview',
        'user-query-file-carousel',
    ].join(', ');

    // Navigation links that look like "files" but are just app routes.
    const APP_ROUTE_RX = /^\/(?:chat|c|app|gem|g|share|settings|projects|recents|new)(?:\/|$)/i;

    // ─── Small helpers ────────────────────────────────────────────────────────

    function absUrl(u) {
        if (!u) return null;
        try {
            if (/^(?:blob:|data:)/i.test(u)) return u;
            return new URL(u, window.location.href).href;
        } catch (_) {
            return null;
        }
    }

    function filenameFromUrl(u) {
        try {
            if (/^(?:blob:|data:)/i.test(u)) return null;
            const url = new URL(u, window.location.href);
            for (const key of ['filename', 'file_name', 'name', 'fn']) {
                const v = url.searchParams.get(key);
                if (v && /\.[A-Za-z0-9]{1,6}$/.test(v)) return decodeURIComponent(v);
            }
            const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
            return /\.[A-Za-z0-9]{1,6}$/.test(last) ? last : null;
        } catch (_) {
            return null;
        }
    }

    function cleanName(s) {
        return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    }

    function isVisibleEnough(el) {
        const r = el.getBoundingClientRect();
        // display:none etc. => 0x0. Off-screen/virtualised content still has size.
        return r.width > 0 || r.height > 0 || (el.naturalWidth || 0) > 0;
    }

    function imageLooksLikeContent(img, minEdge) {
        const src = img.currentSrc || img.src || '';
        if (!src) return false;
        if (/^data:image\/svg/i.test(src) || /\.svg(?:[?#]|$)/i.test(src)) return false;
        if (/google\.com\/s2\/favicons|gstatic\.com\/faviconV2/i.test(src)) return false;

        const hint = `${img.getAttribute('alt') || ''} ${img.className && img.className.baseVal === undefined ? img.className : ''} ${src}`;
        if (JUNK_IMG_HINT_RX.test(hint) && !/uploaded|generated|attachment|upload/i.test(hint)) return false;
        if (img.closest(JUNK_ANCESTOR_SELECTOR)) return false;

        const rect = img.getBoundingClientRect();
        const w = Math.max(rect.width || 0, img.naturalWidth || 0);
        const h = Math.max(rect.height || 0, img.naturalHeight || 0);
        // Lazy images that haven't laid out yet report 0x0; keep them if they have a real src.
        if (w === 0 && h === 0) return true;
        return w >= minEdge && h >= minEdge;
    }

    function guessImageName(img, index, url) {
        const alt = cleanName(img.getAttribute('alt'));
        if (alt && /\.(?:png|jpe?g|gif|webp|heic|bmp)$/i.test(alt)) return alt;
        const fromUrl = filenameFromUrl(url);
        if (fromUrl && IMAGE_URL_RX.test(fromUrl)) return fromUrl;
        return `image-${index + 1}`; // extension is added from the real bytes later
    }

    // ─── Reference collection ─────────────────────────────────────────────────

    /**
     * Collect attachment references (photos + documents) under `root`.
     * Synchronous and read-only: touches no network and reads no pixels.
     *
     * @param {Element} root
     * @param {Object}  [opts]
     * @param {string}  [opts.role]            'user' | 'assistant'
     * @param {number}  [opts.minImageEdge]    ignore images smaller than this (px). Default 48.
     * @param {string}  [opts.chipSelector]    extra/override selector for file chips.
     * @param {string}  [opts.excludeSelector] ignore matches inside this selector (e.g. the message's own text).
     * @param {Function}[opts.normalizeImage]  (url) => ({ url, altUrls?, fileId? }) platform URL upgrades.
     * @returns {Array<{type:'image'|'document', url:(string|null), altUrls:string[], filename:string, fileId?:string, role?:string}>}
     */
    function collectRefs(root, opts = {}) {
        const refs = [];
        if (!root || !root.querySelectorAll) return refs;

        const role = opts.role;
        const minEdge = opts.minImageEdge || 48;
        const chipSelector = opts.chipSelector || DEFAULT_CHIP_SELECTOR;
        const excluded = (el) => !!(opts.excludeSelector && el.closest(opts.excludeSelector));

        const seenUrl = new Set();
        const seenDocName = new Set();

        const pushImage = (url, name, extra) => {
            if (!url || seenUrl.has(url)) return;
            seenUrl.add(url);
            refs.push({ type: 'image', url, altUrls: [], filename: name, role, ...extra });
        };
        const pushDoc = (url, name, extra) => {
            const key = cleanName(name).toLowerCase();
            if (!key) return;
            if (seenDocName.has(key)) {
                // Same document seen twice (chip + link): upgrade the existing entry if it lacked a URL.
                const existing = refs.find((r) => r.type === 'document' && cleanName(r.filename).toLowerCase() === key);
                if (existing && !existing.url && url) { existing.url = url; seenUrl.add(url); }
                return;
            }
            if (url && seenUrl.has(url)) return;
            seenDocName.add(key);
            if (url) seenUrl.add(url);
            refs.push({ type: 'document', url: url || null, altUrls: [], filename: cleanName(name), role, ...extra });
        };

        // 1) File chips / cards (documents) — done first so their thumbnails
        //    are not mistaken for standalone photos below.
        const chipThumbs = new Set();
        const chips = Array.from(root.querySelectorAll(chipSelector)).filter((c) => !excluded(c));
        for (const chip of chips) {
            const text = cleanName(chip.textContent);
            let name = null;
            const attrName = chip.getAttribute('data-filename') || chip.getAttribute('data-file-name') || chip.getAttribute('title') || chip.getAttribute('aria-label');
            if (attrName && FILENAME_IN_TEXT_RX.test(attrName)) name = attrName.match(FILENAME_IN_TEXT_RX)[1];
            if (!name && text && FILENAME_IN_TEXT_RX.test(text) && text.length <= 200) name = text.match(FILENAME_IN_TEXT_RX)[1];
            if (!name) continue;

            // Only treat as a document chip if it is NOT just an image tile.
            let url = null;
            const link = chip.matches('a[href]') ? chip : chip.querySelector('a[href]');
            if (link) url = absUrl(link.getAttribute('href'));
            if (!url) {
                const dataUrl = chip.getAttribute('data-file-url') || chip.getAttribute('data-url') || chip.getAttribute('data-src');
                if (dataUrl) url = absUrl(dataUrl);
            }
            if (url && APP_ROUTE_RX.test(safePath(url))) url = null;

            // Thumbnail inside the chip is a preview of the document, never a separate photo.
            chip.querySelectorAll('img').forEach((im) => chipThumbs.add(im));

            const extra = {};
            const thumb = chip.querySelector('img');
            if (thumb && (thumb.currentSrc || thumb.src)) extra.thumbUrl = absUrl(thumb.currentSrc || thumb.src);
            const fileId = (opts.normalizeImage && extra.thumbUrl) ? (opts.normalizeImage(extra.thumbUrl) || {}).fileId : undefined;
            if (fileId) extra.fileId = fileId;
            pushDoc(url, name, extra);
        }

        // 2) Leaf-text filename scan (robust to unknown class names). Only for
        //    user turns: assistant prose mentions filenames constantly.
        if (role === 'user') {
            root.querySelectorAll('*').forEach((el) => {
                if (el.children.length > 0 || excluded(el)) return;
                if (el.closest('pre, code, button svg')) return;
                const t = cleanName(el.textContent);
                if (!t || !FILENAME_ONLY_RX.test(t)) return;
                const container = el.closest('a[href], [role="button"], button, li, div') || el;
                const link = container.matches('a[href]') ? container : container.querySelector('a[href]');
                let url = link ? absUrl(link.getAttribute('href')) : null;
                if (url && APP_ROUTE_RX.test(safePath(url))) url = null;
                container.querySelectorAll('img').forEach((im) => chipThumbs.add(im));
                const extra = {};
                const thumb = container.querySelector('img');
                if (thumb && (thumb.currentSrc || thumb.src)) {
                    extra.thumbUrl = absUrl(thumb.currentSrc || thumb.src);
                    const fid = opts.normalizeImage ? (opts.normalizeImage(extra.thumbUrl) || {}).fileId : undefined;
                    if (fid) extra.fileId = fid;
                }
                pushDoc(url, t, extra);
            });
        }

        // 3) Explicit download / file links.
        root.querySelectorAll('a[href]').forEach((a) => {
            if (excluded(a)) return;
            const href = a.getAttribute('href') || '';
            if (!href || /^(?:#|javascript:|mailto:|tel:)/i.test(href)) return;
            const url = absUrl(href);
            if (!url) return;
            const path = safePath(url);
            if (APP_ROUTE_RX.test(path)) return;

            const dl = a.getAttribute('download');
            const text = cleanName(a.textContent);
            const urlName = filenameFromUrl(url);
            const looksLikeDoc =
                dl !== null || DOC_URL_RX.test(url) || /\/(?:files?|download|attachments?)\b/i.test(path);
            if (!looksLikeDoc) return;
            // Plain external web links in assistant prose are not attachments.
            if (dl === null && !DOC_URL_RX.test(url) && role === 'assistant') return;

            let name = (dl && FILENAME_IN_TEXT_RX.test(dl) ? dl : null) ||
                (text && FILENAME_IN_TEXT_RX.test(text) ? text.match(FILENAME_IN_TEXT_RX)[1] : null) ||
                urlName;
            if (!name) return;
            if (IMAGE_URL_RX.test(name)) return; // images are handled by the <img> pass
            pushDoc(url, name, {});
        });

        // 4) Photos.
        let imgIndex = 0;
        root.querySelectorAll('img').forEach((img) => {
            // (excludeSelector deliberately NOT applied to photos: generated/uploaded images can sit inside message bodies)
            if (chipThumbs.has(img)) return;
            if (!imageLooksLikeContent(img, role === 'assistant' ? Math.max(minEdge, 96) : minEdge)) return;
            const rawUrl = absUrl(img.currentSrc || img.src || img.getAttribute('data-src'));
            if (!rawUrl) return;
            const norm = opts.normalizeImage ? (opts.normalizeImage(rawUrl) || { url: rawUrl }) : { url: rawUrl };
            const url = norm.url || rawUrl;
            const altUrls = (norm.altUrls || []).filter((u) => u && u !== url);
            if (rawUrl !== url && !altUrls.includes(rawUrl)) altUrls.push(rawUrl);
            const extra = { altUrls };
            if (norm.fileId) extra.fileId = norm.fileId;
            pushImage(url, guessImageName(img, imgIndex++, rawUrl), extra);
        });

        return refs;
    }

    function safePath(u) {
        try { return new URL(u).pathname; } catch (_) { return ''; }
    }

    /** Human marker for the transcript, e.g. "[Attached image: photo.png]". */
    function refsToMarkers(refs) {
        return refs
            .map((r) => `[Attached ${r.type === 'image' ? 'image' : 'file'}: ${r.filename}]`)
            .join(' ');
    }

    // ─── Bytes (fallback paths only) ──────────────────────────────────────────

    const MAX_IN_PAGE_BYTES = 32 * 1024 * 1024; // chrome.runtime messages cap at ~64 MiB incl. base64

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => {
                const s = String(fr.result || '');
                const i = s.indexOf(',');
                resolve(i >= 0 ? s.slice(i + 1) : s);
            };
            fr.onerror = () => reject(fr.error || new Error('read failed'));
            fr.readAsDataURL(blob);
        });
    }

    /**
     * Fetch inside the page context. Works for blob:/data: URLs (which the
     * background worker cannot see) and for same-origin URLs that need the
     * page's own cookies. Returns base64 so it can cross chrome.runtime messaging.
     */
    async function inPageFetch(url) {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (blob.size === 0) throw new Error('empty response');
        if (blob.size > MAX_IN_PAGE_BYTES) throw new Error(`too large for in-page transfer (${Math.round(blob.size / 1048576)} MB)`);
        return {
            mime: blob.type || res.headers.get('content-type') || '',
            size: blob.size,
            disposition: res.headers.get('content-disposition') || '',
            b64: await blobToBase64(blob),
        };
    }

    /** Rebuild a File from stored base64 (used at inject time). */
    function base64ToFile(b64, mime, filename) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new File([bytes], filename || 'attachment', { type: mime || 'application/octet-stream' });
    }

    window.NeuralThreadsAttachments = {
        collectRefs,
        refsToMarkers,
        inPageFetch,
        base64ToFile,
        FILENAME_ONLY_RX,
    };
})();
