/**
 * NeuralThreads - ChatGPT content-script adapter
 * File: extension/content/chatgpt.js
 *
 * Exposes a SINGLE, unified scraper interface on window.NeuralThreadsScraper,
 * which is exactly what content.js consumes:
 *
 *   window.NeuralThreadsScraper = {
 *     platform:            'chatgpt',
 *     scrape():            Promise<Array<{ role:'user'|'assistant', content:string }>>,
 *     getTitle():          string,
 *     getInputSelector():  string   // CSS selector for the composer
 *     isLoggedIn():        boolean,
 *     applyRemoteSelectors(sel): void,
 *   }
 *
 * content.js owns all messaging (NT_EXPORT / NT_INJECT) and the actual DOM
 * injection, so this file only reads the conversation and reports selectors.
 */

(function () {
    'use strict';

    if (!/chatgpt\.com|chat\.openai\.com/.test(window.location.hostname)) return;

    // Current ChatGPT DOM selectors (mid-2025). Kept here as the bundled
    // fallback; applyRemoteSelectors() can override at runtime.
    let SEL = {
        turn: '[data-testid^="conversation-turn"]',
        role: '[data-message-author-role]',
        content: '.markdown, [data-message-content], .whitespace-pre-wrap',
        composer: '#prompt-textarea, textarea[data-id="root"], form textarea',
        loggedIn: '#prompt-textarea, textarea[data-id="root"], nav',
        fileInput: 'input[type="file"]',
        attachButton: '#upload-file-btn, button[data-testid="composer-plus-btn"], button[aria-label*="Attach" i], button[aria-label*="Add photos" i]',
    };


    /** Convert a message element to clean text, preserving code fences + lists. */
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

    async function scrape() {
        const A = window.NeuralThreadsAttachments;
        const turns = Array.from(document.querySelectorAll(SEL.turn));
        const messages = [];

        for (const turn of turns) {
            const roleEl = turn.querySelector(SEL.role) || turn;
            const rawRole = roleEl.getAttribute('data-message-author-role') || '';
            const role = rawRole === 'user' ? 'user' : rawRole === 'assistant' ? 'assistant' : null;
            if (!role) continue; // skip system/tool turns

            const contentEl = turn.querySelector(SEL.content) || roleEl;
            const text = extractText(contentEl);
            let attachmentRefs = [];
            try {
                // Scan the whole turn: user file tiles / uploaded photos sit beside the text, not inside it.
                attachmentRefs = A ? A.collectRefs(turn, {
                    role,
                    excludeSelector: '.markdown, .whitespace-pre-wrap, [data-message-content]',
                }) : [];
            } catch (err) {
                console.warn('[NeuralThreads][chatgpt] attachment scan failed:', err.message);
            }
            const markers = A && attachmentRefs.length ? A.refsToMarkers(attachmentRefs) : '';
            const content = [text, markers].filter(Boolean).join('\n').trim();
            if (!content) continue;
            messages.push(attachmentRefs.length ? { role, content, attachmentRefs } : { role, content });
        }

        return messages;
    }

    function getTitle() {
        const active = document.querySelector('nav a[data-active], nav [aria-current="page"]');
        if (active && active.textContent.trim()) return active.textContent.trim();
        const t = document.title.replace(/\s*[|\-–]\s*ChatGPT\s*$/i, '').trim();
        return t || 'ChatGPT conversation';
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
        return !!document.querySelector('#prompt-textarea, textarea[data-id="root"]');
    }

    function applyRemoteSelectors(remote) {
        // Accept either a flat override object or the selectors.json shape.
        if (!remote || typeof remote !== 'object') return;
        const cg = remote.composer ? remote : (remote.platforms && remote.platforms.chatgpt) || remote.chatgpt;
        if (cg && typeof cg === 'object') SEL = Object.assign({}, SEL, cg);
    }

    window.NeuralThreadsScraper = {
        platform: 'chatgpt',
        scrape,
        getTitle,
        getInputSelector,
        getFileInputSelector,
        getAttachButtonSelector,
        isLoggedIn,
        applyRemoteSelectors,
    };

    console.log('[NeuralThreads][chatgpt] Scraper ready.');
})();
