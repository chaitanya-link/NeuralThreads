/**
 * NeuralThreads - extension/content/content.js
 * -----------------------------------------------
 * Main content script injected into ChatGPT, Claude, and Gemini pages.
 * Acts as the orchestrator: detects platform, loads the right scraper,
 * listens for messages from the popup/background, and coordinates
 * export + inject flows.
 *
 * Architecture notes (v2/v3/v4 safe):
 * - Platform scrapers (chatgpt.js, claude.js, gemini.js) are loaded
 *   separately via manifest content_scripts; this file calls their
 *   exposed window.NeuralThreadsScraper interface.
 * - All inter-script communication goes through chrome.runtime.onMessage
 *   so the popup and background never touch the DOM directly.
 * - Inject flow is always preview-first: background sends summary back to
 *   popup for user approval before this script touches the target input.
 * - Remote config (selectors.json) is fetched by background.js and passed
 *   here via message — this file never fetches it directly.
 * - Raw messages NEVER leave this script to the backend; only summaries do.
 */

(() => {
    'use strict';

    // ─── Constants ────────────────────────────────────────────────────────────

    const NT_VERSION = '1.2.0';

    /** Platforms we recognise by hostname. */
    const PLATFORM_MAP = {
        'chatgpt.com': 'chatgpt',
        'chat.openai.com': 'chatgpt',
        'claude.ai': 'claude',
        'gemini.google.com': 'gemini',
    };

    /** How long to wait for the target input to appear after navigation (ms). */
    const DOM_READY_TIMEOUT = 8000;

    /** Polling interval when waiting for DOM elements (ms). */
    const DOM_POLL_INTERVAL = 250;

    /** How long to wait for a file input to appear/reveal itself before giving up on file-based inject (ms). */
    const FILE_INPUT_TIMEOUT = 1500;

    // ─── Platform Detection ───────────────────────────────────────────────────

    /**
     * Detect which AI platform we're running on.
     * Returns a platform key ('chatgpt' | 'claude' | 'gemini') or null.
     */
    function detectPlatform() {
        const host = window.location.hostname.replace(/^www\./, '');
        return PLATFORM_MAP[host] ?? null;
    }

    const CURRENT_PLATFORM = detectPlatform();

    // Bail out silently on unrecognised pages (e.g. google.com/search).
    if (!CURRENT_PLATFORM) return;

    console.log(`[NeuralThreads] content.js active on platform: ${CURRENT_PLATFORM}`);

    // ─── Scraper Interface ────────────────────────────────────────────────────

    /**
     * Retrieve the platform-specific scraper injected by the matching
     * content script (chatgpt.js / claude.js / gemini.js).
     * The scrapers expose window.NeuralThreadsScraper.
     * Returns null if the scraper hasn't loaded yet.
     */
    function getScraper() {
        return window.NeuralThreadsScraper ?? null;
    }

    /**
     * Wait for the platform scraper to initialise.
     * Scrapers are loaded via manifest content_scripts in document_idle order,
     * so they should be ready almost immediately — but we wait gracefully.
     */
    function waitForScraper(timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const poll = setInterval(() => {
                const scraper = getScraper();
                if (scraper) {
                    clearInterval(poll);
                    resolve(scraper);
                } else if (Date.now() - start > timeoutMs) {
                    clearInterval(poll);
                    reject(new Error(`[NeuralThreads] Scraper not found on ${CURRENT_PLATFORM} after ${timeoutMs}ms`));
                }
            }, DOM_POLL_INTERVAL);
        });
    }

    // ─── DOM Helpers ──────────────────────────────────────────────────────────

    /**
     * Wait for a DOM element matching `selector` to appear.
     * Used before inject to confirm the input box is present.
     */
    function waitForElement(selector, timeoutMs = DOM_READY_TIMEOUT) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(selector);
            if (existing) return resolve(existing);

            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    observer.disconnect();
                    clearTimeout(timer);
                    resolve(el);
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });

            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error(`[NeuralThreads] Element "${selector}" not found within ${timeoutMs}ms`));
            }, timeoutMs);
        });
    }

    /**
     * Detect whether the user appears to be logged in to the current platform.
     * Scrapers expose an isLoggedIn() method; fall back to a best-guess DOM check.
     */
    async function checkLogin() {
        const scraper = getScraper();
        if (scraper?.isLoggedIn) {
            return scraper.isLoggedIn();
        }
        // Fallback heuristic: look for a sign-in button
        const signInHint = document.querySelector(
            '[href*="login"], [href*="signin"], button[data-testid*="login"]'
        );
        return !signInHint;
    }

    // ─── Export Flow ──────────────────────────────────────────────────────────

    /**
     * Scrape the current conversation and return a structured session object.
     * Called only when the user explicitly clicks Export in the popup.
     *
     * Returns:
     * {
     *   platform: string,
     *   url: string,
     *   title: string,
     *   scrapedAt: ISO string,
     *   messages: Array<{ role: 'user'|'assistant', content: string, index: number }>,
     *   metadata: { messageCount, hasCode, languages, turnCount }
     * }
     */
    /**
     * Claude Artifacts, ChatGPT Canvas, and similar features render generated
     * images/code/documents in a SEPARATE panel, not as plain text in the
     * message. All the message bubble itself contains is a small preview
     * card — usually just a title line followed by a "Type · Subtype" line
     * (e.g. "Chaitanya linkedin banner" / "Image · SVG"). Our text scraper
     * can only see that label, never the actual artifact content, so left
     * as-is it gets swept into the transcript looking like ordinary text —
     * confusing, and silently loses the artifact. This flags it explicitly
     * instead, in every scraped message, on every platform.
     */
    function flagArtifactCards(text) {
        const cardRx = /^(.{1,120})\n(Image|Code|Document|Website|Diagram|Spreadsheet|Slides|Canvas|PDF)\s*[·•]\s*(.{1,40})$/gim;
        return text.replace(cardRx, (_match, title, kind, subtype) =>
            `[Generated ${kind.toLowerCase()} artifact "${title.trim()}" (${subtype.trim()}) — NOT included in this export; the actual content lives in a separate panel this scraper can't read. Download it from the original conversation and attach it manually if the next tool needs it.]`
        );
    }

    async function exportConversation(remoteSelectors) {
        const scraper = await waitForScraper();

        // Merge remote selector overrides if provided
        if (remoteSelectors) {
            scraper.applyRemoteSelectors?.(remoteSelectors);
        }

        const rawMessages = await scraper.scrape();

        if (!rawMessages || rawMessages.length === 0) {
            throw new Error('No messages found. Make sure you have an open conversation.');
        }

        rawMessages.forEach((m) => { m.content = flagArtifactCards(m.content || ''); });

        // Gather lightweight attachment REFERENCES (url + filename + type) from
        // every message into one flat, de-duplicated list. No bytes are read
        // here: the background service worker downloads them (it is not bound
        // by the page's CORS rules). Each ref remembers which message it came
        // from so the summary can say "from message N".
        const MAX_TOTAL_REFS = 60;
        const attachmentRefs = [];
        const seen = new Set();
        rawMessages.forEach((m, i) => {
            if (m.attachmentRefs) {
                for (const ref of m.attachmentRefs) {
                    if (attachmentRefs.length >= MAX_TOTAL_REFS) break;
                    const key = ref.fileId || ref.url || `${ref.type}:${(ref.filename || '').toLowerCase()}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    attachmentRefs.push({ ...ref, messageIndex: i, role: m.role });
                }
                delete m.attachmentRefs; // keep raw messages lean
            }
        });

        // Build rich metadata for v3 knowledge graph
        const metadata = buildMetadata(rawMessages);
        // Final counts are set by the background AFTER the bytes are fetched
        // (a ref is only an attachment once its file was actually captured).
        metadata.attachmentRefCount = attachmentRefs.length;

        return {
            platform: CURRENT_PLATFORM,
            url: window.location.href,
            title: scraper.getTitle?.() ?? document.title ?? 'Untitled Conversation',
            scrapedAt: new Date().toISOString(),
            messages: rawMessages,
            attachmentRefs,
            metadata,
        };
    }

    /**
     * Derive session metadata from raw messages.
     * Kept here (not in scraper) so it's consistent across platforms.
     */
    function buildMetadata(messages) {
        const codeBlockRx = /```[\s\S]*?```/;
        const languageRx = /\b(English|Spanish|French|German|Chinese|Japanese|Hindi|Arabic|Portuguese|Russian)\b/i;
        const attachmentRx = /\[Attached (image|file): |\[Generated \w+ artifact /;

        let hasCode = false;
        let hasAttachments = false;
        const detectedLanguages = new Set();

        for (const msg of messages) {
            if (codeBlockRx.test(msg.content)) hasCode = true;
            if (attachmentRx.test(msg.content)) hasAttachments = true;
            const langMatch = msg.content.match(languageRx);
            if (langMatch) detectedLanguages.add(langMatch[1].toLowerCase());
        }

        return {
            messageCount: messages.length,
            turnCount: Math.floor(messages.length / 2),
            hasCode,
            hasAttachments,
            languages: detectedLanguages.size > 0 ? [...detectedLanguages] : ['unknown'],
            platform: CURRENT_PLATFORM,
        };
    }

    // ─── Inject Flow ──────────────────────────────────────────────────────────

    /**
     * Wraps the summary in a .txt file so it lands on the target platform as
     * a real attachment instead of pasted text — the composer never has to
     * reformat/truncate it, and it survives round-tripping through platforms
     * that mangle long pasted text.
     */
    function buildSummaryFile(summary, platform) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `neuralthreads-summary-${platform}-${stamp}.txt`;
        return new File([summary], filename, { type: 'text/plain' });
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * Rebuild real File objects for the captured attachments. The bytes were
     * stored by the background worker, one chrome.storage.local key per file;
     * content scripts can read chrome.storage directly, so nothing large has
     * to travel through message passing.
     */
    async function loadAttachmentFiles(items) {
        const A = window.NeuralThreadsAttachments;
        const files = [];
        const errors = [];
        for (const it of items) {
            try {
                const got = await chrome.storage.local.get(it.key);
                const rec = got[it.key];
                if (!rec || !rec.b64) throw new Error('stored data missing');
                files.push(A.base64ToFile(rec.b64, rec.mime || it.mime, rec.filename || it.filename));
            } catch (err) {
                errors.push(`${it.filename || 'file'}: ${err.message}`);
            }
        }
        return { files, errors };
    }

    /** Matches the "Upload files" / "Add photos & files" / "Attach file" style
     *  entry in an attach menu, while staying clear of cloud-picker entries
     *  like "Google Drive" or "Google Photos" that don't expose a real
     *  input[type=file] (those open their own picker UI instead). */
    const UPLOAD_MENU_ITEM_RX = /\b(upload|file|attach)\b/i;
    const CLOUD_PICKER_RX = /\b(drive|dropbox|onedrive|google photos)\b/i;

    /**
     * Some platforms' attach button doesn't reveal a file input directly —
     * it opens a menu with several destinations (upload / Drive / Photos)
     * and only one of them mounts a real input[type=file]. Finds that item
     * among currently-visible interactive elements.
     */
    function findUploadMenuItem() {
        const candidates = Array.from(
            document.querySelectorAll('button, [role="menuitem"], [role="option"], li')
        );
        return candidates.find((el) => {
            const text = (el.textContent || '').trim();
            if (!text || text.length > 60) return false;
            if (!UPLOAD_MENU_ITEM_RX.test(text) || CLOUD_PICKER_RX.test(text)) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }) ?? null;
    }

    /** True if a file input's `accept` list would take this file. */
    function acceptMatches(accept, file) {
        if (!accept || !accept.trim()) return true;
        const name = (file.name || '').toLowerCase();
        const mime = (file.type || '').toLowerCase();
        return accept.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean).some((p) => {
            if (p.startsWith('.')) return name.endsWith(p);
            if (p.endsWith('/*')) return mime.startsWith(p.slice(0, -1));
            return p === mime;
        });
    }

    /**
     * Route 1 — the platform's own file <input>. Many composers have separate
     * inputs (e.g. "photos" with accept=image/* and "files"), so each file is
     * assigned to an input that will actually take it. If no input is mounted
     * yet, opens the attach menu and drills into the upload entry. Returns the
     * number of files handed to an input (0 = no input found; never throws).
     */
    async function tryFileInputRoute(files, scraper) {
        const selector = scraper.getFileInputSelector?.();
        if (!selector) return 0;

        let inputs = Array.from(document.querySelectorAll(selector));
        let openedMenu = false;

        if (inputs.length === 0) {
            const btnSel = scraper.getAttachButtonSelector?.();
            const btn = btnSel ? document.querySelector(btnSel) : null;
            if (!btn) return 0;
            btn.click();
            openedMenu = true;
            await sleep(300);
            inputs = Array.from(document.querySelectorAll(selector));
            if (inputs.length === 0) {
                const item = findUploadMenuItem();
                if (item) item.click();
                await waitForElement(selector, FILE_INPUT_TIMEOUT).catch(() => null);
                inputs = Array.from(document.querySelectorAll(selector));
            }
            if (inputs.length === 0) {
                if (openedMenu) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                return 0;
            }
        }

        // Assign every file to the first input that accepts it (fallback: first input).
        const groups = new Map();
        for (const f of files) {
            const target = inputs.find((inp) => acceptMatches(inp.getAttribute('accept'), f)) || inputs[0];
            if (!groups.has(target)) groups.set(target, []);
            groups.get(target).push(f);
        }

        let handed = 0;
        for (const [input, group] of groups) {
            // Single-file inputs only keep one file; feed them one at a time.
            const batches = input.multiple ? [group] : group.map((f) => [f]);
            for (const batch of batches) {
                const bdt = new DataTransfer();
                batch.forEach((f) => bdt.items.add(f));
                input.files = bdt.files;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                handed += batch.length;
                await sleep(450); // let the composer render the attachment chip(s)
            }
        }
        return handed;
    }

    /** Route 2 — synthetic paste of the files into the composer. */
    async function tryPasteRoute(files, scraper) {
        const sel = scraper.getInputSelector?.();
        const composer = sel ? document.querySelector(sel) : null;
        if (!composer) return 0;
        try {
            composer.focus();
            const dt = new DataTransfer();
            files.forEach((f) => dt.items.add(f));
            const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            composer.dispatchEvent(ev);
            await sleep(600);
            return files.length;
        } catch (err) {
            console.warn('[NeuralThreads] Paste route failed:', err.message);
            return 0;
        }
    }

    /** Route 3 — synthetic drag-and-drop of the files onto the composer area. */
    async function tryDropRoute(files, scraper) {
        const sel = scraper.getInputSelector?.();
        const composer = sel ? document.querySelector(sel) : null;
        if (!composer) return 0;
        try {
            const target = composer.closest('form') || composer.parentElement || composer;
            const dt = new DataTransfer();
            files.forEach((f) => dt.items.add(f));
            for (const type of ['dragenter', 'dragover', 'drop']) {
                target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
                await sleep(60);
            }
            await sleep(600);
            return files.length;
        } catch (err) {
            console.warn('[NeuralThreads] Drop route failed:', err.message);
            return 0;
        }
    }

    /** Try the three routes in order of reliability; report which one worked. */
    async function attachFiles(files, scraper) {
        if (files.length === 0) return { count: 0, method: null };
        let n = await tryFileInputRoute(files, scraper);
        if (n > 0) return { count: n, method: 'file-input' };
        n = await tryPasteRoute(files, scraper);
        if (n > 0) return { count: n, method: 'paste' };
        n = await tryDropRoute(files, scraper);
        if (n > 0) return { count: n, method: 'drop' };
        return { count: 0, method: null };
    }

    /**
     * Inject a (user-approved) summary into the current platform.
     *
     * Strategy: attach the summary as a .txt through the platform's own upload
     * path, then every captured photo/document (real bytes) alongside it. If
     * attaching everything fails, retries with the summary alone so the user
     * still gets the context. Never auto-submits — the user decides when to send.
     *
     * @param {string} summary
     * @param {Array<{key:string, filename:string, mime?:string, type?:string}>} [attachments]
     */
    async function injectSummary(summary, attachments = []) {
        const loggedIn = await checkLogin();
        if (!loggedIn) {
            throw new Error(`You don't appear to be logged in to ${CURRENT_PLATFORM}. Please log in and try again.`);
        }

        const scraper = await waitForScraper();
        const safeText = sanitiseForInject(summary);
        const summaryFile = buildSummaryFile(safeText, CURRENT_PLATFORM);

        const { files: attachmentFiles, errors } = await loadAttachmentFiles(attachments);

        let result = await attachFiles([summaryFile, ...attachmentFiles], scraper);
        let attachmentsAttached = result.count > 0 ? attachmentFiles.length : 0;

        if (result.count === 0 && attachmentFiles.length > 0) {
            console.warn('[NeuralThreads] Attaching everything failed — retrying with the summary only.');
            result = await attachFiles([summaryFile], scraper);
            attachmentsAttached = 0;
            if (result.count > 0) errors.push('The platform rejected the extra files; only the summary was attached.');
        }

        if (result.count === 0) {
            throw new Error(`Could not attach the summary as a file on ${CURRENT_PLATFORM}. Let the page finish loading and try again.`);
        }

        console.log(`[NeuralThreads] Injected summary + ${attachmentsAttached} attachment(s) via ${result.method}. User must click Send.`);
        return { attachmentsAttached, method: result.method, errors };
    }

    /**
     * Strip potentially dangerous content before injecting into a page.
     * We're injecting into the platform's own input, but be safe.
     */
    function sanitiseForInject(text) {
        return text
            .replace(/<script[\s\S]*?<\/script>/gi, '[script removed]')
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, '')
            .trim();
    }

    // ─── Tab Detection (multi-tab edge case) ─────────────────────────────────

    /**
     * Return basic info about this tab for the popup to display in a tab picker
     * when the user has multiple tabs open on the same platform.
     */
    function getTabInfo() {
        return {
            platform: CURRENT_PLATFORM,
            url: window.location.href,
            title: document.title,
            hasConversation: !!document.querySelector('[data-message-id], .message, [class*="message"]'),
        };
    }

    // ─── Message Router ───────────────────────────────────────────────────────

    /**
     * Listen for messages from the popup and background service worker.
     *
     * Message types handled:
     *   NT_PING            → reply with platform + tab info (popup uses this to
     *                        detect which tabs have NeuralThreads active)
     *   NT_EXPORT          → scrape conversation, return session object
     *   NT_INJECT          → inject approved summary (+ captured attachments) into the composer
     *   NT_FETCH_IN_PAGE   → fetch a blob:/same-origin URL inside the page, return base64
     *   NT_CHECK_LOGIN     → return login status
     */
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message?.type?.startsWith('NT_')) return false;

        console.log(`[NeuralThreads] Message received: ${message.type}`);

        switch (message.type) {

            // ── Ping: popup discovering active content scripts ──────────────────
            case 'NT_PING': {
                sendResponse({
                    success: true,
                    platform: CURRENT_PLATFORM,
                    tabInfo: getTabInfo(),
                    version: NT_VERSION,
                });
                return false; // sync
            }

            // ── Export: scrape conversation ─────────────────────────────────────
            case 'NT_EXPORT': {
                exportConversation(message.remoteSelectors)
                    .then(session => sendResponse({ success: true, session }))
                    .catch(err => {
                        console.error('[NeuralThreads] Export failed:', err);
                        sendResponse({ success: false, error: err.message });
                    });
                return true; // async
            }

            // ── Inject: put approved summary into chat input ────────────────────
            case 'NT_INJECT': {
                if (!message.summary) {
                    sendResponse({ success: false, error: 'No summary provided for inject.' });
                    return false;
                }
                injectSummary(message.summary, message.attachments || [])
                    .then(({ attachmentsAttached, method, errors }) =>
                        sendResponse({ success: true, attachmentsAttached, method, errors }))
                    .catch(err => {
                        console.error('[NeuralThreads] Inject failed:', err);
                        sendResponse({ success: false, error: err.message });
                    });
                return true; // async
            }

            // ── In-page fetch: blob:/data: URLs and same-origin files that need page cookies ──
            case 'NT_FETCH_IN_PAGE': {
                const A = window.NeuralThreadsAttachments;
                if (!A || !message.url) {
                    sendResponse({ success: false, error: 'in-page fetch unavailable' });
                    return false;
                }
                A.inPageFetch(message.url)
                    .then((r) => sendResponse({ success: true, ...r }))
                    .catch((err) => sendResponse({ success: false, error: err.message }));
                return true; // async
            }

            // ── Check login status ──────────────────────────────────────────────
            case 'NT_CHECK_LOGIN': {
                checkLogin()
                    .then(loggedIn => sendResponse({ success: true, loggedIn, platform: CURRENT_PLATFORM }))
                    .catch(err => sendResponse({ success: false, error: err.message }));
                return true; // async
            }

            default:
                return false;
        }
    });

    // ─── Init ─────────────────────────────────────────────────────────────────

    /**
     * Announce readiness to the background service worker.
     * Background uses this to update the extension badge and track active tabs.
     */
    function announceReady() {
        chrome.runtime.sendMessage({
            type: 'NT_CONTENT_READY',
            platform: CURRENT_PLATFORM,
            url: window.location.href,
            title: document.title,
        }).catch(() => {
            // Background may not be listening yet on first install — safe to ignore
        });
    }

    // Wait for the page to be interactive before announcing
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', announceReady);
    } else {
        announceReady();
    }

    // Handle SPA navigation (ChatGPT and Gemini navigate without full page reload)
    let lastUrl = window.location.href;
    new MutationObserver(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            console.log(`[NeuralThreads] SPA navigation detected on ${CURRENT_PLATFORM}: ${lastUrl}`);
            // Re-announce so background updates tab registry
            setTimeout(announceReady, 500);
        }
    }).observe(document.body, { childList: true, subtree: true });

})();