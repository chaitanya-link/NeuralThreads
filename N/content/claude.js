/**
 * NeuralThreads - Claude content-script adapter
 * File: extension/content/claude.js
 *
 * Exposes the unified window.NeuralThreadsScraper interface consumed by
 * content.js. content.js owns messaging + injection; this file only reads
 * the conversation and reports the composer selector.
 */

(function () {
    'use strict';

    if (!window.location.hostname.includes('claude.ai')) return;

    let SEL = {
        // User and assistant message blocks (tried in order until one matches).
        userMessage: ['[data-testid="user-message"]', 'div[data-testid="user-message"]', '.font-user-message'],
        assistantMessage: ['.font-claude-message', '[data-testid="assistant-message"]', '.font-claude-response'],
        // Prose fallback when the above don't match.
        prose: '.prose, [class*="whitespace-pre-wrap"]',
        composer: 'div.ProseMirror[contenteditable="true"], div[contenteditable="true"].ProseMirror, .ProseMirror, div[contenteditable="true"]',
        fileInput: 'input[type="file"]',
        attachButton: 'button[data-testid="upload-menu-button"], button[aria-label*="Attach" i], button[aria-label*="Upload" i]',
    };


    function extractText(el) {
        if (!el) return '';
        const clone = el.cloneNode(true);
        clone.querySelectorAll('button, [role="button"], .sr-only, [aria-hidden="true"]').forEach((n) => n.remove());
        clone.querySelectorAll('pre').forEach((pre) => {
            const code = pre.querySelector('code');
            const lang = (code && code.className.match(/language-(\w+)/)) ? code.className.match(/language-(\w+)/)[1] : '';
            const text = (code ? code.textContent : pre.textContent) || '';
            pre.replaceWith(document.createTextNode(`\n\`\`\`${lang}\n${text}\n\`\`\`\n`));
        });
        clone.querySelectorAll('li').forEach((li) => {
            li.prepend(document.createTextNode('- '));
            li.append(document.createTextNode('\n'));
        });
        clone.querySelectorAll('p, br, h1, h2, h3, h4, h5, h6, div').forEach((n) => n.prepend(document.createTextNode('\n')));
        const text = (clone.textContent || '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
        return text;
    }

    // ── Attachment references ────────────────────────────────────────────────
    // Claude serves uploads from /api/<org>/files/<uuid>/(preview|thumbnail).
    // Prefer the full-size "preview"; keep the thumbnail as a fallback.
    const CLAUDE_FILE_URL_RX = /^(https:\/\/claude\.ai\/api\/[^/]+(?:\/[^/]+)?\/files\/)([0-9a-f-]{36})\/(thumbnail|preview)(.*)$/i;

    function normalizeImage(url) {
        const m = CLAUDE_FILE_URL_RX.exec(url || '');
        if (!m) return { url };
        const base = `${m[1]}${m[2]}`;
        return {
            url: `${base}/preview${m[4] || ''}`,
            altUrls: [`${base}/thumbnail${m[4] || ''}`, url],
            fileId: m[2].toLowerCase(),
        };
    }

    /**
     * In Claude's DOM, uploaded photos/files are rendered in a SIBLING of the
     * [data-testid="user-message"] text bubble, not inside it. Climb from the
     * text element to the largest ancestor that still contains only this one
     * message, so those sibling containers are scanned too.
     */
    function turnRoot(el, allEls) {
        let node = el;
        while (node.parentElement && node.parentElement !== document.body) {
            const parent = node.parentElement;
            const containsOther = allEls.some((o) => o !== el && parent.contains(o));
            if (containsOther) break;
            node = parent;
        }
        return node;
    }

    function firstMatch(selectors) {
        for (const s of selectors) {
            const nodes = document.querySelectorAll(s);
            if (nodes.length) return Array.from(nodes);
        }
        return [];
    }

    async function scrape() {
        const users = firstMatch(SEL.userMessage);
        const ais = firstMatch(SEL.assistantMessage);

        let pool = [
            ...users.map((el) => ({ el, role: 'user' })),
            ...ais.map((el) => ({ el, role: 'assistant' })),
        ];

        // Fallback: alternate prose blocks (user, assistant, user, ...) if the
        // role-specific selectors found nothing.
        if (pool.length === 0) {
            const proseBlocks = Array.from(document.querySelectorAll(SEL.prose));
            pool = proseBlocks.map((el, i) => ({ el, role: i % 2 === 0 ? 'user' : 'assistant' }));
        }

        // Order by DOM position so turns interleave correctly.
        pool.sort((a, b) =>
            a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
        );

        const A = window.NeuralThreadsAttachments;
        const allEls = pool.map((p) => p.el);
        const messages = [];
        for (const { el, role } of pool) {
            let text = extractText(el);
            let attachmentRefs = [];
            try {
                attachmentRefs = A ? A.collectRefs(turnRoot(el, allEls), {
                    role,
                    normalizeImage,
                    excludeSelector: '[data-testid="user-message"], .font-claude-message, .font-user-message',
                }) : [];
            } catch (err) {
                console.warn('[NeuralThreads][claude] attachment scan failed:', err.message);
            }
            const markers = A && attachmentRefs.length ? A.refsToMarkers(attachmentRefs) : '';
            const content = [text, markers].filter(Boolean).join('\n').trim();
            if (!content) continue;
            messages.push(attachmentRefs.length ? { role, content, attachmentRefs } : { role, content });
        }
        return messages;
    }

    function getTitle() {
        const t = document.title.replace(/\s*[|\-–]\s*Claude\s*$/i, '').trim();
        if (t && t.toLowerCase() !== 'claude') return t;
        const active = document.querySelector('a[aria-current="page"], [class*="ConversationItem--active"]');
        if (active && active.textContent.trim()) return active.textContent.trim();
        return 'Claude conversation';
    }

    function getInputSelector() {
        return SEL.composer;
    }

    function getFileInputSelector() {
        return SEL.fileInput;
    }

    function getAttachButtonSelector() {
        return SEL.attachButton;
    }

    function isLoggedIn() {
        return !!document.querySelector('.ProseMirror, [data-testid="user-menu-button"], div[contenteditable="true"]');
    }

    function applyRemoteSelectors(remote) {
        if (!remote || typeof remote !== 'object') return;
        const cl = remote.composer ? remote : (remote.platforms && remote.platforms.claude) || remote.claude;
        if (cl && typeof cl === 'object') SEL = Object.assign({}, SEL, cl);
    }

    window.NeuralThreadsScraper = {
        platform: 'claude',
        scrape,
        getTitle,
        getInputSelector,
        getFileInputSelector,
        getAttachButtonSelector,
        isLoggedIn,
        applyRemoteSelectors,
    };

    console.log('[NeuralThreads][claude] Scraper ready.');
})();
