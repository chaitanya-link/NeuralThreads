/**
 * NeuralThreads - Gemini content-script adapter
 * File: extension/content/gemini.js
 *
 * Exposes the unified window.NeuralThreadsScraper interface consumed by
 * content.js. content.js owns messaging + injection; this file only reads
 * the conversation and reports the composer selector.
 */

(function () {
    'use strict';

    if (!window.location.hostname.includes('gemini.google.com')) return;

    let SEL = {
        // Gemini renders alternating <user-query> / <model-response> custom elements.
        turn: 'user-query, model-response',
        userText: '.query-text, .user-query-text, [class*="query-text"]',
        assistantText: '.model-response-text, message-content, .markdown, [class*="markdown"]',
        composer: '.ql-editor[contenteditable="true"], rich-textarea .ql-editor, div[contenteditable="true"][aria-label], textarea[aria-label]',
        fileInput: 'input[type="file"]',
        attachButton: 'button[aria-label*="Add files" i], button[aria-label*="Upload" i], toolbox-drawer-item button',
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

    function buildMessage(role, textEl, rootEl) {
        const A = window.NeuralThreadsAttachments;
        const text = extractText(textEl);
        let attachmentRefs = [];
        try {
            // Gemini renders uploaded photos/files in sibling components of the text node,
            // so scan the whole <user-query>/<model-response> turn when we have it.
            attachmentRefs = A ? A.collectRefs(rootEl, {
                role,
                excludeSelector: SEL.userText + ', ' + SEL.assistantText,
            }) : [];
        } catch (err) {
            console.warn('[NeuralThreads][gemini] attachment scan failed:', err.message);
        }
        const markers = A && attachmentRefs.length ? A.refsToMarkers(attachmentRefs) : '';
        const content = [text, markers].filter(Boolean).join('\n').trim();
        if (!content) return null;
        return attachmentRefs.length ? { role, content, attachmentRefs } : { role, content };
    }

    async function scrape() {
        const messages = [];
        const turns = Array.from(document.querySelectorAll(SEL.turn));

        if (turns.length) {
            for (const turn of turns) {
                const tag = turn.tagName.toLowerCase();
                const role = tag === 'user-query' ? 'user' : 'assistant';
                const inner = turn.querySelector(role === 'user' ? SEL.userText : SEL.assistantText) || turn;
                const msg = buildMessage(role, inner, turn);
                if (msg) messages.push(msg);
            }
        } else {
            // Fallback: separate user + model text nodes, interleaved by DOM order.
            const users = Array.from(document.querySelectorAll(SEL.userText)).map((el) => ({ el, role: 'user' }));
            const ais = Array.from(document.querySelectorAll(SEL.assistantText)).map((el) => ({ el, role: 'assistant' }));
            const pool = [...users, ...ais].sort((a, b) =>
                a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
            );
            for (const { el, role } of pool) {
                const msg = buildMessage(role, el, el);
                if (msg) messages.push(msg);
            }
        }

        return messages;
    }

    function getTitle() {
        const t = document.title.replace(/\s*[|\-–]\s*Gemini.*$/i, '').trim();
        return t || 'Gemini conversation';
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
        return !!document.querySelector('.ql-editor, rich-textarea, div[contenteditable="true"]');
    }

    function applyRemoteSelectors(remote) {
        if (!remote || typeof remote !== 'object') return;
        const g = remote.composer ? remote : (remote.platforms && remote.platforms.gemini) || remote.gemini;
        if (g && typeof g === 'object') SEL = Object.assign({}, SEL, g);
    }

    window.NeuralThreadsScraper = {
        platform: 'gemini',
        scrape,
        getTitle,
        getInputSelector,
        getFileInputSelector,
        getAttachButtonSelector,
        isLoggedIn,
        applyRemoteSelectors,
    };

    console.log('[NeuralThreads][gemini] Scraper ready.');
})();
