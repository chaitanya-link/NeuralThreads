/**
 * NeuralThreads — popup/popup.js
 * 
 * Controls all popup UI logic:
 *  - Tab navigation (Sessions / Settings / Account)
 *  - API key save / validate / clear (Chrome local storage, never leaves browser)
 *  - Storage mode toggle (Local Only vs Cloud Sync)
 *  - Session library render with platform filter
 *  - Export trigger → content script
 *  - Inject trigger → summary preview → content script
 *  - Auth (signup / login / logout) via backend REST
 *  - Cloud sync status display
 * 
 * Designed so v2 (web app), v3 (knowledge graph tags), v4 (agent routing)
 * can read the same chrome.storage schema without migration.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BACKEND_URL = 'http://localhost:5000'; // dev default; overridable in Settings → Backend URL

const PLATFORMS = ['chatgpt', 'claude', 'gemini'];

const PLATFORM_LABELS = {
    chatgpt: 'ChatGPT',
    claude: 'Claude',
    gemini: 'Gemini',
};

// Matches manifest host_permissions — used for tab detection.
// Arrays because ChatGPT serves from both chatgpt.com and chat.openai.com.
const PLATFORM_URL_PATTERNS = {
    chatgpt: ['chatgpt.com', 'chat.openai.com'],
    claude: ['claude.ai'],
    gemini: ['gemini.google.com'],
};

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
    sessions: [],   // loaded from chrome.storage.local
    filteredPlatform: 'all',
    currentUser: null, // { id, email, token }
    storageMode: 'local', // 'local' | 'cloud'
    activePlatform: null, // platform of the currently active tab
    apiKeyValidated: false,
};

// ─── DOM refs (populated after DOMContentLoaded) ───────────────────────────────

let dom = {};

function cacheDom() {
    // Tabs
    dom.tabs = document.querySelectorAll('.tab-btn');
    dom.tabPanels = document.querySelectorAll('.tab-panel');

    // Sessions panel
    dom.sessionList = document.getElementById('session-list');
    dom.filterBtns = document.querySelectorAll('.filter-pill');
    dom.exportBtn = document.getElementById('export-btn');
    dom.currentPlatform = document.getElementById('current-platform');
    dom.emptyState = document.getElementById('empty-state');

    // Summary preview modal
    dom.previewModal = document.getElementById('preview-modal');
    dom.previewText = document.getElementById('preview-text');
    dom.previewEdit = document.getElementById('preview-edit');
    dom.compressionStats = document.getElementById('compression-stats');
    dom.statOriginal = document.getElementById('stat-original');
    dom.statCompressed = document.getElementById('stat-compressed');
    dom.statRatio = document.getElementById('stat-ratio');
    dom.injectBtn = document.getElementById('inject-btn');
    dom.cancelPreview = document.getElementById('cancel-preview');
    dom.injectTarget = document.getElementById('inject-target');
    dom.injectTargetNote = document.getElementById('inject-target-note');
    dom.attachmentNote = document.getElementById('attachment-note');

    // Settings panel
    dom.backendUrlInput = document.getElementById('backend-url-input');
    dom.backendUrlStatus = document.getElementById('backend-url-status');
    dom.saveBackendUrl = document.getElementById('save-backend-url');
    dom.resetBackendUrl = document.getElementById('reset-backend-url');
    dom.apiKeyInput = document.getElementById('api-key-input');
    dom.apiKeyToggle = document.getElementById('api-key-toggle');
    dom.saveApiKey = document.getElementById('save-api-key');
    dom.clearApiKey = document.getElementById('clear-api-key');
    dom.apiKeyStatus = document.getElementById('api-key-status');
    dom.storageModeToggle = document.getElementById('storage-mode-toggle');
    dom.storageModeLabel = document.getElementById('storage-mode-label');
    dom.storageModeDesc = document.getElementById('storage-mode-desc');

    // Account panel
    dom.authSection = document.getElementById('auth-section');
    dom.accountSection = document.getElementById('account-section');
    dom.loginForm = document.getElementById('login-form');
    dom.signupForm = document.getElementById('signup-form');
    dom.emailInput = document.getElementById('auth-email');
    dom.passwordInput = document.getElementById('auth-password');
    dom.loginBtn = document.getElementById('login-btn');
    dom.signupBtn = document.getElementById('signup-btn');
    dom.showSignup = document.getElementById('show-signup');
    dom.showLogin = document.getElementById('show-login');
    dom.authError = document.getElementById('auth-error');
    dom.accountEmail = document.getElementById('account-email');
    dom.accountMode = document.getElementById('account-mode');
    dom.syncStatus = document.getElementById('sync-status');
    dom.logoutBtn = document.getElementById('logout-btn');

    // Global status bar
    dom.statusBar = document.getElementById('status-bar');
    dom.statusMsg = document.getElementById('status-msg');
}

// ─── Initialisation ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    cacheDom();
    bindEvents();

    // Load persisted state from Chrome storage
    const stored = await chromeGet([
        'sessions', 'storageMode', 'currentUser', 'apiKeyValidated'
    ]);

    state.sessions = stored.sessions || [];
    state.storageMode = stored.storageMode || 'local';
    state.currentUser = stored.currentUser || null;
    state.apiKeyValidated = stored.apiKeyValidated || false;

    // Detect which AI platform the active tab is on
    state.activePlatform = await detectActivePlatform();

    // Render initial UI
    renderPlatformBadge();
    renderSessionList();
    renderStorageToggle();
    renderAccountPanel();
    await renderApiKeyStatus();
    await renderBackendUrlStatus();
});

// ─── Chrome storage helpers ────────────────────────────────────────────────────

function chromeGet(keys) {
    return new Promise((resolve) =>
        chrome.storage.local.get(keys, (result) => resolve(result))
    );
}

function chromeSet(obj) {
    return new Promise((resolve) =>
        chrome.storage.local.set(obj, resolve)
    );
}

function chromeRemove(keys) {
    return new Promise((resolve) =>
        chrome.storage.local.remove(keys, resolve)
    );
}

// ─── Active tab detection ──────────────────────────────────────────────────────

async function detectActivePlatform() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || !tabs[0]) return resolve(null);
            const url = tabs[0].url || '';
            for (const [platform, patterns] of Object.entries(PLATFORM_URL_PATTERNS)) {
                if (patterns.some((p) => url.includes(p))) return resolve(platform);
            }
            resolve(null);
        });
    });
}

// ─── Tab navigation ────────────────────────────────────────────────────────────

function bindTabNavigation() {
    dom.tabs.forEach((btn) => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;

            dom.tabs.forEach((b) => b.classList.remove('active'));
            dom.tabPanels.forEach((p) => p.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(`panel-${target}`)?.classList.add('active');
        });
    });
}

// ─── Sessions panel ────────────────────────────────────────────────────────────

function renderPlatformBadge() {
    if (!dom.currentPlatform) return;
    if (state.activePlatform) {
        dom.currentPlatform.textContent =
            `Active: ${PLATFORM_LABELS[state.activePlatform]}`;
        dom.currentPlatform.className = `platform-badge platform-${state.activePlatform}`;
        dom.exportBtn.disabled = false;
    } else {
        dom.currentPlatform.textContent = 'No AI platform detected';
        dom.currentPlatform.className = 'platform-badge platform-none';
        dom.exportBtn.disabled = true;
    }
}

function renderSessionList() {
    const filtered = state.filteredPlatform === 'all'
        ? state.sessions
        : state.sessions.filter((s) => s.platform === state.filteredPlatform);

    // Sort newest first
    filtered.sort((a, b) => (b.exportedAt || 0) - (a.exportedAt || 0));

    dom.sessionList.innerHTML = '';

    if (filtered.length === 0) {
        dom.emptyState.style.display = 'flex';
        return;
    }

    dom.emptyState.style.display = 'none';

    filtered.forEach((session) => {
        const card = buildSessionCard(session);
        dom.sessionList.appendChild(card);
    });
}

function buildSessionCard(session) {
    const card = document.createElement('div');
    card.className = `session-card platform-border-${session.platform}`;
    card.dataset.sessionId = session.id;

    const date = session.exportedAt
        ? new Date(session.exportedAt).toLocaleDateString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        })
        : 'Unknown date';

    const msgCount = session.metadata?.messageCount ?? session.messages?.length ?? 0;
    const syncIcon = session.synced ? '☁️' : '💾';
    const titleText = session.title || 'Untitled session';
    const summaryBadge = session.aiSummary === false ? ' · no AI summary' : '';
    const imageCount = session.metadata?.imageCount || 0;
    const docCount = session.metadata?.documentCount || 0;
    const attFailed = session.metadata?.attachmentFailures || 0;
    const imageBadge =
        (imageCount ? ` · 📷 ${imageCount}` : '') +
        (docCount ? ` · 📄 ${docCount}` : '') +
        (attFailed ? ` · ⚠ ${attFailed} not captured` : '');
    const tokenBadge = session.tokenStats
        ? ` · ~${formatTokenCount(session.tokenStats.originalTokens)}→${formatTokenCount(session.tokenStats.summaryTokens)} tok (${session.tokenStats.savedPct}% saved)`
        : '';

    card.innerHTML = `
    <div class="card-header">
      <span class="card-platform tag-${session.platform}">
        ${PLATFORM_LABELS[session.platform] || session.platform}
      </span>
      <span class="card-sync-icon" title="${session.synced ? 'Synced to cloud' : 'Local only'}">${syncIcon}</span>
    </div>
    <div class="card-title" title="${escapeHtml(titleText)}">${escapeHtml(titleText)}</div>
    <div class="card-meta">${msgCount} messages · ${date}${summaryBadge}${imageBadge}${tokenBadge}</div>
    <div class="card-actions">
      <button class="btn-secondary btn-sm inject-session-btn" data-session-id="${session.id}">
        ↗ Inject
      </button>
      <button class="btn-ghost btn-sm delete-session-btn" data-session-id="${session.id}">
        🗑
      </button>
    </div>
  `;

    // Inject button — opens summary preview
    card.querySelector('.inject-session-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openPreviewModal(session);
    });

    // Delete button
    card.querySelector('.delete-session-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSession(session.id);
    });

    return card;
}

// Platform filter buttons
function bindFilterButtons() {
    dom.filterBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            dom.filterBtns.forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            state.filteredPlatform = btn.dataset.platform;
            renderSessionList();
        });
    });
}

// ─── Export ────────────────────────────────────────────────────────────────────

function bindExportButton() {
    dom.exportBtn.addEventListener('click', async () => {
        if (!state.activePlatform) {
            showStatus('Navigate to ChatGPT, Claude, or Gemini first.', 'warn');
            return;
        }

        const hasKey = await apiKeyExists();

        const exportBtnHtml = dom.exportBtn.innerHTML;
        dom.exportBtn.disabled = true;
        dom.exportBtn.textContent = 'Exporting…';
        showStatus('Reading conversation…', 'info');
        // The .txt downloads first, then Gemini writes the summary. Say so,
        // otherwise it looks like nothing is happening.
        const slowNote = setTimeout(() => {
            showStatus('.txt saved. Writing AI summary — keep this popup open (up to ~1 min)…', 'info');
        }, 3000);

        try {
            // Ask background to run the scrape via content script
            const response = await sendMessageToBackground({
                type: 'EXPORT_SESSION',
                platform: state.activePlatform,
            });

            if (response?.error) {
                throw new Error(response.error);
            }

            // Background already saved the session and handed it back —
            // splice it in directly instead of re-reading all sessions
            // from storage, which would just re-fetch what we already have.
            if (response.session) {
                state.sessions.unshift(response.session);
            } else {
                await reloadSessions();
            }
            renderSessionList();
            const gotAiSummary = response.session?.aiSummary !== false;
            const attNote = describeAttachmentReport(response.attachmentReport);
            if (response.attachmentReport?.failed) {
                // Never fail silently: say exactly which files did not make it, and why.
                showStatus(`Exported. ${attNote}`, 'warn');
            } else if (gotAiSummary) {
                showStatus(`Session exported — .txt saved to Downloads${attNote ? ` · ${attNote}` : ''} ✓`, 'success');
            } else if (!hasKey) {
                showStatus('Exported (no AI summary — add a Gemini key in Settings for one) ✓', 'success');
            } else {
                // A key IS set, so the fallback means Gemini itself failed —
                // show the real reason instead of the generic "no key" message.
                showStatus(`Exported, but AI summary failed (${response.warning || 'unknown Gemini error'}) — used a basic summary instead ✓`, 'warn');
            }
        } catch (err) {
            console.error('[NeuralThreads] Export error:', err);
            showStatus(`Export failed: ${err.message}`, 'error');
        } finally {
            clearTimeout(slowNote);
            dom.exportBtn.disabled = false;
            dom.exportBtn.innerHTML = exportBtnHtml;
        }
    });
}

/** One-line, honest summary of what was captured and what failed (with reasons). */
function describeAttachmentReport(report) {
    if (!report || !report.requested) return '';
    const ok = `${report.saved}/${report.requested} attachment${report.requested > 1 ? 's' : ''} captured`;
    if (!report.failed) return ok;
    const first = (report.failures || []).slice(0, 2)
        .map((f) => `${f.filename}: ${String(f.reason).slice(0, 90)}${f.host ? ` [${f.host}]` : ''}`)
        .join(' · ');
    const more = report.failed > 2 ? ` (+${report.failed - 2} more)` : '';
    return `${ok}; ${report.failed} failed — ${first}${more}`;
}

// ─── Inject / Preview modal ────────────────────────────────────────────────────

function openPreviewModal(session) {
    // Populate summary text; user may edit before inject
    const summaryText = session.summary || '[No summary yet — will be generated on inject]';
    dom.previewEdit.value = summaryText;

    // Compression stats (original transcript tokens → summary tokens)
    if (session.tokenStats) {
        dom.statOriginal.textContent = `${formatTokenCount(session.tokenStats.originalTokens)} tokens in`;
        dom.statCompressed.textContent = `${formatTokenCount(session.tokenStats.summaryTokens)} tokens out`;
        dom.statRatio.textContent = `${session.tokenStats.savedPct}% saved`;
        dom.compressionStats.hidden = false;
    } else {
        dom.compressionStats.hidden = true;
    }

    // Populate inject target selector. Any platform is a valid target,
    // including the one the session was exported from — re-injecting into
    // the source platform is how you carry context into a fresh chat there
    // once a conversation gets long or hits a context limit.
    dom.injectTarget.innerHTML = '';
    PLATFORMS.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = PLATFORM_LABELS[p];
        dom.injectTarget.appendChild(opt);
    });

    // Default to the active tab's platform when we detected one, otherwise
    // the session's own source platform.
    dom.injectTarget.value = state.activePlatform || session.platform;

    updateInjectTargetNote(session.platform);

    if (dom.attachmentNote) {
        const atts = session.attachments || [];
        if (atts.length) {
            const imgs = atts.filter((a) => a.type === 'image').length;
            const docs = atts.length - imgs;
            const parts = [imgs && `${imgs} photo${imgs > 1 ? 's' : ''}`, docs && `${docs} document${docs > 1 ? 's' : ''}`].filter(Boolean);
            dom.attachmentNote.textContent = `Will also attach ${parts.join(' + ')} with the summary.`;
            dom.attachmentNote.hidden = false;
        } else {
            dom.attachmentNote.hidden = true;
        }
    }

    dom.previewModal.dataset.sessionId = session.id;
    dom.previewModal.dataset.sourcePlatform = session.platform;

    // Show the preview as an active panel (the .tab-panel display rule keys off
    // `.active`, not a bespoke `.open` class), hiding the other panels.
    dom.tabPanels.forEach((p) => p.classList.remove('active'));
    dom.previewModal.hidden = false;
    dom.previewModal.classList.add('active');
    dom.injectBtn.disabled = false;
}

function closePreviewModal() {
    dom.previewModal.classList.remove('active');
    dom.previewModal.hidden = true;
    dom.previewModal.dataset.sessionId = '';
    dom.previewModal.dataset.sourcePlatform = '';
    if (dom.injectTargetNote) dom.injectTargetNote.hidden = true;
    if (dom.attachmentNote) dom.attachmentNote.hidden = true;
    switchTab('library');
}

/**
 * Keep the inject-target note informational rather than a restriction:
 * flag when the chosen target is the session's source platform, since that
 * means "start a fresh chat here with this context" rather than "send to a
 * different tool" — worth knowing, never worth blocking.
 */
function updateInjectTargetNote(sourcePlatform) {
    if (!dom.injectTargetNote) return;
    const target = dom.injectTarget.value;
    if (target === sourcePlatform) {
        dom.injectTargetNote.textContent =
            `This opens a fresh ${PLATFORM_LABELS[sourcePlatform]} chat with this context pre-loaded.`;
        dom.injectTargetNote.hidden = false;
    } else {
        dom.injectTargetNote.hidden = true;
    }
}

function bindPreviewModal() {
    dom.cancelPreview.addEventListener('click', closePreviewModal);

    // Close on backdrop click
    dom.previewModal.addEventListener('click', (e) => {
        if (e.target === dom.previewModal) closePreviewModal();
    });

    dom.injectTarget.addEventListener('change', () => {
        updateInjectTargetNote(dom.previewModal.dataset.sourcePlatform);
    });

    dom.injectBtn.addEventListener('click', async () => {
        const sessionId = dom.previewModal.dataset.sessionId;
        const target = dom.injectTarget.value;
        const editedSummary = dom.previewEdit.value.trim();

        if (!editedSummary) {
            showStatus('Summary cannot be empty.', 'warn');
            return;
        }

        if (!target) {
            showStatus('Select an inject target platform.', 'warn');
            return;
        }

        dom.injectBtn.disabled = true;
        dom.injectBtn.textContent = 'Injecting…';

        try {
            const response = await sendMessageToBackground({
                type: 'INJECT_SUMMARY',
                target,
                summary: editedSummary,
                sessionId,
            });

            if (response?.error) throw new Error(response.error);

            closePreviewModal();
            const want = response.attachmentsRequested || 0;
            const got = response.attachmentsAttached || 0;
            const skipped = response.attachmentsSkipped || 0;
            if (want && got < want) {
                const why = (response.attachErrors || [])[0] || 'the page did not accept the extra files';
                showStatus(`Injected summary into ${PLATFORM_LABELS[target]}, but only ${got}/${want} attachments went through (${why}).`, 'warn');
            } else {
                const fileNote = got ? ` (+${got} file${got > 1 ? 's' : ''})` : '';
                const skipNote = skipped ? ` — ${skipped} more skipped (per-message file limit)` : '';
                showStatus(`Injected into ${PLATFORM_LABELS[target]}${fileNote}${skipNote} ✓`, 'success');
            }
        } catch (err) {
            console.error('[NeuralThreads] Inject error:', err);
            showStatus(`Inject failed: ${err.message}`, 'error');
        } finally {
            dom.injectBtn.disabled = false;
            dom.injectBtn.textContent = '↗ Inject into Target';
        }
    });
}

// ─── Session management helpers ────────────────────────────────────────────────

async function reloadSessions() {
    const stored = await chromeGet(['sessions']);
    state.sessions = stored.sessions || [];
}

async function deleteSession(sessionId) {
    // Delete via background so the cloud copy is removed by its Mongo cloudId
    // (the local id is NOT the cloud id). Background handles local + cloud.
    sendMessageToBackground({ action: 'DELETE_SESSION', payload: { sessionId } }).catch(() => { });

    state.sessions = state.sessions.filter((s) => s.id !== sessionId);
    await chromeSet({ sessions: state.sessions });
    renderSessionList();
    showStatus('Session deleted.', 'info');
}

// ─── API Key (Settings panel) ─────────────────────────────────────────────────

async function renderApiKeyStatus() {
    const { geminiApiKey } = await chromeGet(['geminiApiKey']);
    if (geminiApiKey) {
        const masked = geminiApiKey.slice(0, 6) + '•'.repeat(
            Math.max(0, geminiApiKey.length - 10)
        ) + geminiApiKey.slice(-4);
        dom.apiKeyStatus.textContent = `Saved: ${masked}`;
        dom.apiKeyStatus.className = 'api-key-status ok';
    } else {
        dom.apiKeyStatus.textContent = 'No API key saved';
        dom.apiKeyStatus.className = 'api-key-status empty';
    }
}

async function apiKeyExists() {
    const { geminiApiKey } = await chromeGet(['geminiApiKey']);
    return !!(geminiApiKey && geminiApiKey.length > 10);
}

function bindApiKeyControls() {
    // Show / hide toggle
    dom.apiKeyToggle.addEventListener('click', () => {
        const isHidden = dom.apiKeyInput.type === 'password';
        dom.apiKeyInput.type = isHidden ? 'text' : 'password';
        dom.apiKeyToggle.textContent = isHidden ? '🙈 Hide' : '👁 Show';
    });

    // Save
    dom.saveApiKey.addEventListener('click', async () => {
        const key = dom.apiKeyInput.value.trim();
        if (!key || key.length < 20) {
            showStatus('Enter a valid Gemini API key.', 'warn');
            return;
        }

        dom.saveApiKey.disabled = true;
        dom.saveApiKey.textContent = 'Validating…';

        const valid = await validateGeminiKey(key);
        if (!valid) {
            showStatus('API key rejected by Gemini. Check the key and try again.', 'error');
            dom.saveApiKey.disabled = false;
            dom.saveApiKey.textContent = 'Save Key';
            return;
        }

        // Store ONLY in chrome.storage.local — never sent to backend
        await chromeSet({ geminiApiKey: key, apiKeyValidated: true });
        state.apiKeyValidated = true;

        dom.apiKeyInput.value = '';
        await renderApiKeyStatus();
        showStatus('API key saved locally ✓', 'success');
        dom.saveApiKey.disabled = false;
        dom.saveApiKey.textContent = 'Save Key';
    });

    // Clear
    dom.clearApiKey.addEventListener('click', async () => {
        await chromeRemove(['geminiApiKey', 'apiKeyValidated']);
        state.apiKeyValidated = false;
        await renderApiKeyStatus();
        showStatus('API key cleared.', 'info');
    });
}

/**
 * Calls Gemini API directly from the browser to validate the key.
 * The key never touches our backend.
 */
async function validateGeminiKey(key) {
    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
            { method: 'GET' }
        );
        return res.ok;
    } catch {
        return false;
    }
}

// ─── Storage mode toggle ───────────────────────────────────────────────────────

function renderStorageToggle() {
    const isCloud = state.storageMode === 'cloud';
    dom.storageModeToggle.checked = isCloud;
    dom.storageModeLabel.textContent = isCloud ? 'Cloud Sync' : 'Local Only';
    dom.storageModeDesc.textContent = isCloud
        ? 'Summaries synced to your account. Raw messages stay local.'
        : 'Everything stays on this device. No account required.';
}

function bindStorageModeToggle() {
    dom.storageModeToggle.addEventListener('change', async () => {
        const isCloud = dom.storageModeToggle.checked;

        // If switching to cloud, must be logged in
        if (isCloud && !state.currentUser) {
            dom.storageModeToggle.checked = false; // revert
            showStatus('Log in or create an account to enable Cloud Sync.', 'warn');
            return;
        }

        state.storageMode = isCloud ? 'cloud' : 'local';
        await chromeSet({ storageMode: state.storageMode });
        renderStorageToggle();
        showStatus(
            isCloud
                ? 'Cloud Sync enabled — new sessions will sync automatically.'
                : 'Local Only mode — sessions stay on this device.',
            'info'
        );
    });
}

// ─── Account / Auth panel ─────────────────────────────────────────────────────

function renderAccountPanel() {
    if (state.currentUser) {
        dom.authSection.style.display = 'none';
        dom.accountSection.style.display = 'flex';
        dom.accountEmail.textContent = state.currentUser.email;
        dom.accountMode.textContent =
            state.storageMode === 'cloud' ? 'Cloud Sync active' : 'Local Only mode';
        dom.syncStatus.textContent = ''; // updated after sync attempts
    } else {
        dom.authSection.style.display = 'flex';
        dom.accountSection.style.display = 'none';
    }
}

function bindAuthControls() {
    // Toggle between Login and Signup forms
    dom.showSignup?.addEventListener('click', () => {
        dom.loginForm.style.display = 'none';
        dom.signupForm.style.display = 'flex';
        dom.authError.textContent = '';
    });

    dom.showLogin?.addEventListener('click', () => {
        dom.signupForm.style.display = 'none';
        dom.loginForm.style.display = 'flex';
        dom.authError.textContent = '';
    });

    // Login
    dom.loginBtn?.addEventListener('click', async () => {
        const email = dom.emailInput.value.trim();
        const password = dom.passwordInput.value;

        if (!validateAuthInputs(email, password)) return;

        dom.loginBtn.disabled = true;
        dom.loginBtn.textContent = 'Logging in…';
        dom.authError.textContent = '';

        try {
            const data = await authRequest('AUTH_LOGIN', { email, password });
            await onAuthSuccess(data);
        } catch (err) {
            showAuthError(err.message);
        } finally {
            dom.loginBtn.disabled = false;
            dom.loginBtn.textContent = 'Log In';
        }
    });

    // Signup
    dom.signupBtn?.addEventListener('click', async () => {
        const email = dom.emailInput.value.trim();
        const password = dom.passwordInput.value;

        if (!validateAuthInputs(email, password)) return;

        dom.signupBtn.disabled = true;
        dom.signupBtn.textContent = 'Creating account…';
        dom.authError.textContent = '';

        try {
            const data = await authRequest('AUTH_SIGNUP', { email, password });
            await onAuthSuccess(data);
        } catch (err) {
            showAuthError(err.message);
        } finally {
            dom.signupBtn.disabled = false;
            dom.signupBtn.textContent = 'Create Account';
        }
    });

    // Logout
    dom.logoutBtn?.addEventListener('click', async () => {
        state.currentUser = null;

        // If storage was cloud, flip to local on logout
        if (state.storageMode === 'cloud') {
            state.storageMode = 'local';
            await chromeSet({ storageMode: 'local' });
            renderStorageToggle();
        }

        await chromeRemove(['currentUser', 'access_token', 'refresh_token']);
        renderAccountPanel();
        showStatus('Logged out.', 'info');
    });
}

function showAuthError(msg) {
    dom.authError.textContent = msg;
    dom.authError.hidden = false; // element ships with the `hidden` attribute
}

function validateAuthInputs(email, password) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showAuthError('Enter a valid email address.');
        return false;
    }
    if (!password || password.length < 8) {
        showAuthError('Password must be at least 8 characters.');
        return false;
    }
    return true;
}

async function authRequest(type, body) {
    // Goes through background.js so the Settings → Backend URL override is
    // actually used (background reads chrome.storage.local.backend_url;
    // this used to fetch a hardcoded localhost URL directly and ignore it).
    const res = await sendMessageToBackground({ type, payload: body });
    if (!res || !res.success) throw new Error(res?.error || 'Auth failed. Try again.');
    return res; // { success, user, accessToken, refreshToken }
}

async function onAuthSuccess(data) {
    // Backend returns { user: { id, email, storageMode }, accessToken, refreshToken }
    state.currentUser = {
        id: data.user.id,
        email: data.user.email,
        token: data.accessToken,
        refreshToken: data.refreshToken,
    };

    // Persist tokens under the keys background.js reads for cloud sync + refresh.
    await chromeSet({
        currentUser: state.currentUser,
        access_token: data.accessToken,
        refresh_token: data.refreshToken,
    });

    // Auto-enable cloud sync on first login
    if (state.storageMode !== 'cloud') {
        state.storageMode = 'cloud';
        await chromeSet({ storageMode: 'cloud' });
        renderStorageToggle();
    }

    renderAccountPanel();
    showStatus(`Welcome, ${state.currentUser.email} ✓`, 'success');
}

// ─── Communication with background.js ─────────────────────────────────────────

function sendMessageToBackground(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(response);
            }
        });
    });
}

// ─── Status bar ────────────────────────────────────────────────────────────────

let statusTimer = null;

function showStatus(message, type = 'info') {
    // types: info | success | warn | error
    dom.statusMsg.textContent = message;
    dom.statusBar.className = `status-bar status-${type}`;
    dom.statusBar.style.display = 'flex';

    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
        dom.statusBar.style.display = 'none';
        dom.statusMsg.textContent = '';
    }, 4000);
}

// ─── Tab switch helper (used programmatically) ─────────────────────────────────

function switchTab(tabName) {
    dom.tabs.forEach((b) => b.classList.remove('active'));
    dom.tabPanels.forEach((p) => p.classList.remove('active'));

    const targetBtn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    const targetPanel = document.getElementById(`panel-${tabName}`);
    if (targetBtn) targetBtn.classList.add('active');
    if (targetPanel) targetPanel.classList.add('active');
}

// ─── Utility ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 1420 → "1.4k", 310 → "310" — compact token-count display for cards/preview. */
function formatTokenCount(n) {
    if (n == null) return '?';
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// ─── Bind all events ───────────────────────────────────────────────────────────

function bindEvents() {
    bindTabNavigation();
    bindFilterButtons();
    bindExportButton();
    bindPreviewModal();
    bindBackendUrlControls();
    bindApiKeyControls();
    bindStorageModeToggle();
    bindAuthControls();
}

// ─── Backend URL (Settings panel) ─────────────────────────────────────────────

async function renderBackendUrlStatus() {
    const { backend_url } = await chromeGet(['backend_url']);
    dom.backendUrlInput.value = backend_url || '';
    dom.backendUrlStatus.textContent = backend_url
        ? `Using: ${backend_url}`
        : `Using default: ${DEFAULT_BACKEND_URL}`;
}

function bindBackendUrlControls() {
    dom.saveBackendUrl?.addEventListener('click', async () => {
        const url = dom.backendUrlInput.value.trim().replace(/\/+$/, '');
        if (!url || !/^https?:\/\/.+/.test(url)) {
            showStatus('Enter a valid URL, e.g. https://your-backend.example.com', 'warn');
            return;
        }
        await chromeSet({ backend_url: url });
        await renderBackendUrlStatus();
        showStatus('Backend URL saved ✓', 'success');
    });

    dom.resetBackendUrl?.addEventListener('click', async () => {
        await chromeRemove(['backend_url']);
        await renderBackendUrlStatus();
        showStatus('Backend URL reset to default.', 'info');
    });
}

/**
 * Listen for background.js broadcasting a session-saved event
 * so the session list updates in real time while the popup is open.
 */
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SESSION_SAVED') {
        reloadSessions().then(renderSessionList);

        if (message.synced) {
            showStatus('Session saved & synced to cloud ✓', 'success');
        } else {
            showStatus('Session saved locally ✓', 'success');
        }
    }

    if (message.type === 'SYNC_ERROR') {
        showStatus(`Cloud sync failed: ${message.error}`, 'warn');
    }
});