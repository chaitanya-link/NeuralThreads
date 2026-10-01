/**
 * NeuralThreads - background/background.js
 * Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  - Message broker between popup ↔ content scripts
 *  - Gemini API calls (embedding + summarization) — API key never leaves browser
 *  - RAG pipeline: chunk → embed → retrieve → summarize
 *  - Cloud sync (background, non-blocking) for Cloud Sync mode users
 *  - Remote config fetch + cache with bundled fallback
 *  - Tab management helpers
 *  - Attachment capture (photos + documents) via ./attachments.js — bytes are
 *    downloaded HERE (host permissions, no page CORS) and stored per-file
 *  - JWT token refresh cycle
 *
 * Architecture rules enforced here:
 *  - Gemini API key read only from chrome.storage.local, never forwarded to backend
 *  - Raw messages never sent to backend; only compressed summaries
 *  - Local save always happens first; cloud sync fires after
 *  - Remote config validated before use; falls back to bundled selectors.json
 */

'use strict';

import { captureAttachments, deleteAttachments } from './attachments.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const GEMINI_EMBED_URL =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';
// Fallback chain, tried in order — Google keeps retiring specific model
// snapshots out from under pinned IDs (2.0-flash quota zeroed, then
// 2.5-flash-lite retired outright) and free-tier capacity dips (503) happen
// independently of any single model. The "-latest" alias is tried first since
// it tracks whatever Google currently recommends; the pinned IDs after it are
// a safety net if the alias itself is ever degraded. thinkingBudget is forced
// to 0 in callGenerate() so a small maxOutputTokens reliably returns summary
// text instead of an empty response, regardless of which model answers.
// "gemini-3.5-flash" (previous 3rd entry) is not a real Gemini model name and
// always 404'd, silently eating one retry cycle on every summary. Replaced
// with gemini-3.1-flash-lite, which is GA-stable as of this writing.
const GEMINI_GEN_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-3.1-flash-lite'];

// Remote config is OFF by default: the URL below is a placeholder
// (YOUR_ORG/neuralthreads-config does not exist) and would 404 on every
// install + every 6-hour alarm forever, doing nothing but adding console
// noise and a wasted network round trip. The bundled config/selectors.json
// (read by getSelectors()) is used instead until you host a real one.
// To enable: set REMOTE_CONFIG_ENABLED to true and point the URL at your
// own hosted, valid selectors.json (same shape as config/selectors.json).
const REMOTE_CONFIG_ENABLED = false;
const REMOTE_CONFIG_URL =
    'https://raw.githubusercontent.com/YOUR_ORG/neuralthreads-config/main/selectors.json';

const REMOTE_CONFIG_CACHE_KEY = 'remote_config_cache';
const REMOTE_CONFIG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const CHUNK_SIZE = 800;        // tokens (approx chars / 4)
const CHUNK_OVERLAP = 100;     // overlap between chunks
// Was 5 — too thin to cover "everything" in a long conversation. Retrieval
// still exists to prioritize the most relevant chunks first, but the cap is
// now generous enough that most long conversations get most of their
// substance included, not just a sliver.
const TOP_K = 16;
// Was a flat 600 (~600 words/tokens) for EVERY conversation, short or long —
// a full multi-turn technical conversation cannot survive that and remain
// useful to another AI. This is now a CEILING, not a fixed target: actual
// output budget is computed per-conversation in summaryTokenBudget() below,
// scaled to how much material there is, up to what the model can return.
const MAX_SUMMARY_TOKENS = 8000;

// Conversations at or under this length get summarized directly in a single
// generateContent call — no chunk/embed/retrieve at all. Free-tier quota is
// spent per-request, not per-token, so skipping RAG for the common case (most
// exported chats) is what actually keeps everyday exports off the rate limit,
// not which model answers. RAG only kicks in above this size, where it's
// genuinely needed to fit the conversation into one prompt.
// Raised from 20k: gemini-flash's context window comfortably fits a much
// larger transcript in one call, and the chunk/batch-embed/retrieve path
// below costs a second full network round-trip — every conversation that
// stays under this limit exports roughly twice as fast as one that doesn't.
const DIRECT_SUMMARY_CHAR_LIMIT = 60000; // ~15,000 tokens

const BACKEND_BASE = 'http://localhost:5000'; // dev default; override via chrome.storage.local 'backend_url' for prod
// Loaded from storage at runtime so it can be updated without code change.

const RETRY_DELAYS_MS = [2000, 5000, 15000]; // Gemini rate-limit retry backoff

// ─── Alarm names ─────────────────────────────────────────────────────────────

const ALARM_REMOTE_CONFIG = 'refresh_remote_config';
const ALARM_TOKEN_REFRESH = 'refresh_jwt';

// ─── Lifecycle ───────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('[NeuralThreads] onInstalled', details.reason);

    // Seed default settings on first install
    if (details.reason === 'install') {
        await chrome.storage.local.set({
            storageMode: 'local',   // 'local' | 'cloud' — same key the popup uses
            sessions: [],
            onboarding_complete: false,
        });
    }

    // Schedule periodic remote config refresh
    chrome.alarms.create(ALARM_REMOTE_CONFIG, { periodInMinutes: 360 });

    // Fetch remote config immediately on install/update
    await fetchAndCacheRemoteConfig();
});

chrome.runtime.onStartup.addListener(async () => {
    console.log('[NeuralThreads] onStartup');
    await fetchAndCacheRemoteConfig();
    await maybeScheduleTokenRefresh();
});

// ─── Alarm handler ───────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_REMOTE_CONFIG) {
        await fetchAndCacheRemoteConfig();
    }
    if (alarm.name === ALARM_TOKEN_REFRESH) {
        await refreshJwt();
    }
});

// ─── Message router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Must return true to keep channel open for async responses
    handleMessage(message, sender)
        .then(sendResponse)
        .catch((err) => {
            console.error('[NeuralThreads] message handler error', err);
            sendResponse({ success: false, error: err.message });
        });
    return true;
});

/**
 * Central async dispatcher. Each action maps to a handler function.
 */
async function handleMessage(message, sender) {
    const { payload } = message;
    // The popup speaks `type`, older callers speak `action` — accept both.
    const action = message.action || message.type;

    switch (action) {
        // ── High-level orchestration (called by the popup) ──────────────────────
        case 'EXPORT_SESSION':
            return exportSession(message.platform);

        case 'INJECT_SUMMARY':
            return injectSummaryToPlatform(message.target, message.summary, message.sessionId);

        // Content-script lifecycle pings — acknowledged, nothing to do.
        case 'NT_CONTENT_READY':
        case 'NAVIGATION':
            return { success: true };

        // ── Config ──────────────────────────────────────────────────────────────
        case 'GET_SELECTORS':
            return { success: true, data: await getSelectors() };

        case 'VALIDATE_API_KEY':
            return validateApiKey(payload.apiKey);

        // ── Session management ──────────────────────────────────────────────────
        case 'SAVE_SESSION':
            return saveSession(payload.session);

        case 'GET_SESSIONS':
            return getSessions(payload?.filter);

        case 'DELETE_SESSION':
            return deleteSession(payload.sessionId);

        // ── RAG pipeline ────────────────────────────────────────────────────────
        case 'COMPRESS_SESSION':
            return compressSession(payload.messages, payload.sessionMeta);

        // ── Injection helpers ───────────────────────────────────────────────────
        case 'GET_ACTIVE_TAB_PLATFORM':
            return getActiveTabPlatform();

        case 'OPEN_PLATFORM_TAB':
            return openPlatformTab(payload.platform);

        // ── Auth ────────────────────────────────────────────────────────────────
        case 'AUTH_SIGNUP':
            return authSignup(payload);

        case 'AUTH_LOGIN':
            return authLogin(payload);

        case 'AUTH_LOGOUT':
            return authLogout();

        case 'GET_AUTH_STATE':
            return getAuthState();

        // ── Cloud sync ──────────────────────────────────────────────────────────
        case 'SYNC_SESSION_TO_CLOUD':
            return syncSessionToCloud(payload.sessionId);

        default:
            console.warn('[NeuralThreads] Unknown action:', action);
            return { success: false, error: `Unknown action: ${action}` };
    }
}

// ─── Remote config ───────────────────────────────────────────────────────────

/**
 * Fetches remote selectors.json and caches it.
 * Falls back to bundled config/selectors.json on failure.
 */
async function fetchAndCacheRemoteConfig() {
    if (!REMOTE_CONFIG_ENABLED) return; // see comment on REMOTE_CONFIG_ENABLED above
    try {
        const res = await fetch(REMOTE_CONFIG_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();

        // Basic structure validation — must have at least one platform key
        const requiredPlatforms = ['chatgpt', 'claude', 'gemini'];
        const hasAllPlatforms = requiredPlatforms.every((p) => json[p]);
        if (!hasAllPlatforms) throw new Error('Remote config missing platform keys');

        await chrome.storage.local.set({
            [REMOTE_CONFIG_CACHE_KEY]: {
                data: json,
                fetchedAt: Date.now(),
            },
        });
        console.log('[NeuralThreads] Remote config refreshed');
    } catch (err) {
        console.warn('[NeuralThreads] Remote config fetch failed, using cache/bundled:', err.message);
    }
}

/**
 * Returns selectors: cached remote → bundled fallback.
 */
async function getSelectors() {
    const store = await chrome.storage.local.get(REMOTE_CONFIG_CACHE_KEY);
    const cached = store[REMOTE_CONFIG_CACHE_KEY];

    if (cached && Date.now() - cached.fetchedAt < REMOTE_CONFIG_TTL_MS) {
        return cached.data;
    }

    // Fallback: load bundled selectors.json via fetch (works from service worker)
    try {
        const url = chrome.runtime.getURL('config/selectors.json');
        const res = await fetch(url);
        return await res.json();
    } catch (err) {
        console.error('[NeuralThreads] Could not load bundled selectors:', err);
        return {};
    }
}

// ─── API key validation ───────────────────────────────────────────────────────

/**
 * Validates a Gemini API key by making a lightweight embed call.
 * Key is NEVER sent to our backend.
 */
async function validateApiKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.startsWith('AIza')) {
        return { success: false, error: 'API key format invalid. Gemini keys start with "AIza".' };
    }

    try {
        const res = await fetch(`${GEMINI_EMBED_URL}?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: { parts: [{ text: 'test' }] },
            }),
        });

        if (res.status === 400) {
            // 400 can mean key is valid but bad request — still valid key
            return { success: true };
        }
        if (res.status === 403) {
            return { success: false, error: 'API key rejected by Google. Check key and billing.' };
        }
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            return { success: false, error: body?.error?.message || `HTTP ${res.status}` };
        }

        return { success: true };
    } catch (err) {
        return { success: false, error: `Network error: ${err.message}` };
    }
}

// ─── Session management ───────────────────────────────────────────────────────

/**
 * Saves a session locally (immediately), then triggers cloud sync if enabled.
 * Raw messages stay local only — cloud receives summary only.
 *
 * Session schema (v1, designed for v3 knowledge graph):
 * {
 *   id: string (uuid),
 *   title: string,
 *   platform: 'chatgpt' | 'claude' | 'gemini',
 *   url: string,
 *   messages: Message[],      // raw — local only
 *   summary: string | null,   // RAG compressed — syncs to cloud
 *   chunks: Chunk[],          // embedded chunks — local only
 *   tags: string[],           // for v3 knowledge graph
 *   createdAt: ISO string,
 *   updatedAt: ISO string,
 *   synced: boolean,
 *   cloudId: string | null,   // MongoDB _id after sync
 * }
 */
async function saveSession(session) {
    if (!session?.id) return { success: false, error: 'Session missing id' };

    const store = await chrome.storage.local.get('sessions');
    const sessions = store.sessions || [];

    // Upsert by id
    const idx = sessions.findIndex((s) => s.id === session.id);
    const updatedSession = {
        ...session,
        updatedAt: new Date().toISOString(),
        synced: false,
    };

    if (idx >= 0) {
        sessions[idx] = updatedSession;
    } else {
        updatedSession.createdAt = updatedSession.createdAt || new Date().toISOString();
        sessions.unshift(updatedSession);
    }

    await chrome.storage.local.set({ sessions });
    console.log('[NeuralThreads] Session saved locally:', session.id);

    // Background cloud sync (non-blocking)
    const { storageMode } = await chrome.storage.local.get('storageMode');
    if (storageMode === 'cloud') {
        syncSessionToCloud(session.id).catch((e) =>
            console.warn('[NeuralThreads] Background cloud sync failed:', e.message)
        );
    }

    return { success: true, sessionId: session.id };
}

/**
 * Returns sessions from local storage, optionally filtered by platform.
 */
async function getSessions(filter) {
    const store = await chrome.storage.local.get('sessions');
    let sessions = store.sessions || [];

    if (filter?.platform) {
        sessions = sessions.filter((s) => s.platform === filter.platform);
    }

    // Strip raw messages from response to popup (they stay in storage only)
    return {
        success: true,
        data: sessions.map(({ messages, chunks, images, ...rest }) => rest),
    };
}

/**
 * Deletes a session locally and from cloud if synced.
 */
async function deleteSession(sessionId) {
    if (!sessionId) return { success: false, error: 'Missing sessionId' };

    const store = await chrome.storage.local.get('sessions');
    const sessions = store.sessions || [];
    const session = sessions.find((s) => s.id === sessionId);

    const updated = sessions.filter((s) => s.id !== sessionId);
    await chrome.storage.local.set({ sessions: updated });

    // Remove the stored attachment bytes (one storage key per file).
    deleteAttachments(session?.attachments).catch((e) =>
        console.warn('[NeuralThreads] Attachment cleanup failed:', e.message)
    );

    // Delete from cloud if it was synced
    if (session?.cloudId) {
        deleteSessionFromCloud(session.cloudId).catch((e) =>
            console.warn('[NeuralThreads] Cloud delete failed:', e.message)
        );
    }

    return { success: true };
}

// ─── RAG pipeline ─────────────────────────────────────────────────────────────

/**
 * Full RAG compression pipeline:
 *   1. Flatten messages to text
 *   2. Chunk text with overlap
 *   3. Embed each chunk via Gemini text-embedding-004
 *   4. Retrieve top-K most relevant chunks (cosine similarity to query)
 *   5. Generate summary via gemini-1.5-flash
 *
 * @param {Array} messages  - Array of {role, content} objects
 * @param {Object} sessionMeta - {platform, title, url}
 * @returns {Object} { success, summary, chunks }
 */
async function compressSession(messages, sessionMeta) {
    const store = await chrome.storage.local.get('geminiApiKey');
    const apiKey = store.geminiApiKey;

    // 1. Flatten messages (needed either way — AI summary or raw fallback)
    const fullText = flattenMessages(messages);
    if (!fullText.trim()) {
        return { success: false, error: 'No text content to compress.' };
    }

    if (!apiKey) {
        // No key set — export must still succeed. Fall back to a raw,
        // truncated excerpt so Save/Inject always have SOMETHING to work
        // with; the popup shows a soft warning instead of blocking export.
        console.warn('[NeuralThreads] No Gemini API key set — using raw-excerpt fallback summary.');
        const fallbackSummary = buildFallbackSummary(fullText, sessionMeta);
        return { success: true, summary: fallbackSummary, chunks: [], aiSummary: false, tokenStats: buildTokenStats(fullText, fallbackSummary) };
    }

    try {
        // Short-circuit: most exported conversations fit comfortably in a single
        // prompt. Skip chunk/embed/retrieve entirely and spend exactly ONE
        // Gemini request on the whole transcript — free-tier limits are per
        // request, so this is what keeps a typical export off the rate limit.
        if (fullText.length <= DIRECT_SUMMARY_CHAR_LIMIT) {
            console.log(`[NeuralThreads] Text within direct limit (${fullText.length} chars) — single-call summary, no embedding.`);
            const summary = await generateSummary([{ text: fullText }], sessionMeta, apiKey);
            return { success: true, summary, chunks: [], aiSummary: true, tokenStats: buildTokenStats(fullText, summary) };
        }

        // 2. Chunk (only reached for conversations too long for one prompt)
        const chunks = chunkText(fullText, CHUNK_SIZE, CHUNK_OVERLAP);
        console.log(`[NeuralThreads] RAG: ${chunks.length} chunks from ${messages.length} messages`);

        let embeddedChunks = [];
        let topChunks;

        // Preferred path: embed every chunk PLUS the retrieval query in a single
        // batched request (batchEmbedContents), then retrieve the top-K most
        // relevant by cosine similarity. One request regardless of chunk count —
        // the previous per-chunk-call loop was the main way a long conversation
        // could burn through the whole free-tier rate limit on embedding alone.
        // If embeddings are unavailable for any reason (model 404, rate limit,
        // network), we DON'T fail the export — we fall back to a representative
        // slice of the conversation so the user still gets a summary.
        try {
            const query = buildRetrievalQuery(sessionMeta, messages);
            const allEmbeddings = await batchEmbedTexts([...chunks, query], apiKey);
            const queryEmbedding = allEmbeddings[allEmbeddings.length - 1];
            embeddedChunks = chunks.map((text, i) => ({ text, embedding: allEmbeddings[i] }));
            topChunks = retrieveTopK(embeddedChunks, queryEmbedding, TOP_K);
        } catch (embErr) {
            console.warn('[NeuralThreads] Embedding step unavailable — summarizing without retrieval:', embErr.message);
            topChunks = selectFallbackChunks(chunks, TOP_K);
        }

        // Generate summary from the selected chunks.
        const summary = await generateSummary(topChunks, sessionMeta, apiKey);

        return {
            success: true,
            summary,
            aiSummary: true,
            tokenStats: buildTokenStats(fullText, summary),
            chunks: embeddedChunks.map(({ text, embedding }) => ({
                text,
                embedding, // stored locally for future semantic search (v2)
            })),
        };
    } catch (err) {
        // A Gemini/network error here (bad key, rate limit, outage) should
        // degrade the export, not fail it outright — the user already has a
        // scraped conversation and a .txt in Downloads at this point.
        console.warn('[NeuralThreads] RAG pipeline error, using raw-excerpt fallback:', err.message);
        const fallbackSummary = buildFallbackSummary(fullText, sessionMeta);
        return { success: true, summary: fallbackSummary, chunks: [], aiSummary: false, warning: err.message, tokenStats: buildTokenStats(fullText, fallbackSummary) };
    }
}

/**
 * Raw-excerpt fallback used whenever an AI summary can't be produced (no key,
 * bad key, Gemini outage/rate limit). Not as dense as a real summary, but it
 * means Export and Inject keep working end-to-end without Gemini at all.
 * Takes the head and tail of the transcript, where intent + conclusions
 * usually live, capped to a size any composer can attach as a file.
 */
function buildFallbackSummary(fullText, sessionMeta) {
    const CAP = 6000;
    const header = `[No AI summary — add a Gemini API key in NeuralThreads Settings for a compressed summary]\n\n${sessionMeta.platform} conversation: ${sessionMeta.title || 'Untitled'}\n\n`;
    let body = fullText;
    if (body.length > CAP) {
        const head = body.slice(0, Math.ceil(CAP * 0.6));
        const tail = body.slice(-Math.floor(CAP * 0.4));
        body = `${head}\n\n[... middle truncated ...]\n\n${tail}`;
    }
    return header + body;
}

// Fallback chunk selection used when embeddings can't be computed. Takes the
// opening and closing of the conversation, where the user's intent and the
// conclusions usually live. Returns objects shaped like the retrieval output
// so generateSummary() can consume them unchanged.
function selectFallbackChunks(chunks, k) {
    if (chunks.length <= k) return chunks.map((text) => ({ text }));
    const head = Math.ceil(k / 2);
    const tail = k - head;
    const picked = [...chunks.slice(0, head), ...chunks.slice(chunks.length - tail)];
    return picked.map((text) => ({ text }));
}

/**
 * Flatten message array into a single transcript string.
 * Preserves role labels and code blocks (no stripping).
 */
function flattenMessages(messages) {
    return messages
        .map((m) => {
            const role = m.role === 'assistant' ? 'AI' : 'Human';
            return `${role}: ${m.content}`;
        })
        .join('\n\n');
}

/**
 * Splits text into overlapping chunks.
 * Uses character count as proxy for token count (tokens ≈ chars / 4).
 */
function chunkText(text, chunkSizeChars, overlapChars) {
    const chunks = [];
    let start = 0;
    const step = chunkSizeChars - overlapChars;

    while (start < text.length) {
        const end = Math.min(start + chunkSizeChars, text.length);
        chunks.push(text.slice(start, end));
        if (end === text.length) break;
        start += step;
    }

    return chunks;
}

/**
 * Embeds any number of texts in ONE HTTP request via Gemini's batchEmbedContents,
 * instead of one request per text. Free-tier limits are per-request, so this is
 * what actually keeps a long conversation's embedding step off the rate limit —
 * a 20-chunk conversation used to cost 20 separate embed calls; now it costs 1.
 * Returns embeddings in the same order as the input texts.
 * Retries the whole batch on 429/503 with exponential backoff.
 */
async function batchEmbedTexts(texts, apiKey, attempt = 0) {
    const url = `${GEMINI_EMBED_URL.replace(':embedContent', ':batchEmbedContents')}`;
    const modelName = GEMINI_EMBED_URL.match(/models\/([^:]+):/)[1];

    const res = await fetch(`${url}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            requests: texts.map((text) => ({
                model: `models/${modelName}`,
                content: { parts: [{ text }] },
            })),
        }),
    });

    if ((res.status === 429 || res.status === 503) && attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        console.warn(`[NeuralThreads] Batch embed ${res.status === 429 ? 'rate limited' : 'overloaded'}, retrying in ${delay}ms`);
        await sleep(delay);
        return batchEmbedTexts(texts, apiKey, attempt + 1);
    }

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`Embed error ${res.status}: ${body?.error?.message || 'Unknown'}`);
    }

    const data = await res.json();
    return data.embeddings.map((e) => e.values); // Float32 arrays, same order as input
}

/**
 * Builds a semantic query string for chunk retrieval.
 * Combines platform context + last few human messages.
 */
function buildRetrievalQuery(sessionMeta, messages) {
    const humanMessages = messages
        .filter((m) => m.role === 'user')
        .slice(-3)
        .map((m) => m.content)
        .join(' ');

    return `Context from a ${sessionMeta.platform} conversation titled "${sessionMeta.title}": ${humanMessages}`;
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

/**
 * Returns the top-K most relevant chunks sorted by cosine similarity to query.
 */
function retrieveTopK(embeddedChunks, queryEmbedding, k) {
    const scored = embeddedChunks.map((chunk) => ({
        ...chunk,
        score: cosineSimilarity(chunk.embedding, queryEmbedding),
    }));

    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
}

/**
 * How many output tokens to ask Gemini for, scaled to how much material is
 * actually in the conversation. A one-message chat and a 200-message deep-dive
 * shouldn't get the same budget. Rough rule: ~1 output token per 3 input
 * chars (generous — a handoff doc can legitimately approach the source
 * length when it's preserving code/specifics rather than compressing prose),
 * floored so short chats still get a decently complete writeup, capped at
 * MAX_SUMMARY_TOKENS so it stays within what the model can return in one call.
 */
function summaryTokenBudget(inputCharCount) {
    const estimate = Math.round(inputCharCount / 3);
    return Math.max(1200, Math.min(MAX_SUMMARY_TOKENS, estimate));
}

/**
 * Rough token estimate (~4 chars/token, the standard approximation for
 * English text — matches what CHUNK_SIZE and DIRECT_SUMMARY_CHAR_LIMIT
 * already assume elsewhere in this file). Not exact — real tokenizers vary
 * by model — but good enough to show the user a before/after instead of
 * nothing. Shown in the Inject preview and on each session card.
 */
function estimateTokens(str) {
    return Math.max(1, Math.round((str || '').length / 4));
}

function buildTokenStats(fullText, summaryText) {
    const originalTokens = estimateTokens(fullText);
    const summaryTokens = estimateTokens(summaryText);
    const savedTokens = Math.max(0, originalTokens - summaryTokens);
    const savedPct = originalTokens > 0 ? Math.round((savedTokens / originalTokens) * 100) : 0;
    return { originalTokens, summaryTokens, savedTokens, savedPct };
}


/**
 * Generates a natural language summary from top retrieved chunks.
 * Prompt is crafted for cross-platform injection readability.
 *
 * Tries each model in GEMINI_GEN_MODELS in order. A model that's rate-limited
 * or overloaded (429/503) gets retried with backoff on the SAME model first
 * (transient — likely to recover); a model that's gone entirely (404, or that
 * exhausts its retries) is abandoned in favor of the next one in the list, so
 * a single Google-side deprecation or outage degrades quietly instead of
 * failing the export.
 */
async function generateSummary(topChunks, sessionMeta, apiKey) {
    const context = topChunks.map((c, i) => `[${i + 1}] ${c.text}`).join('\n\n');
    const tokenBudget = summaryTokenBudget(context.length);

    const prompt = `You are NeuralThreads, an AI memory layer that transfers conversations between AI platforms (ChatGPT, Claude, Gemini). Your output will be attached as a file and read by a DIFFERENT AI assistant that has NEVER seen this conversation, so it can pick up exactly where the user left off.

Conversation metadata:
- Platform: ${sessionMeta.platform}
- Title: ${sessionMeta.title || 'Untitled'}
- URL: ${sessionMeta.url || ''}
${sessionMeta.attachmentNote || ''}

Full (or most-relevant, if long) excerpts from the conversation, in order:

${context}

Write a thorough context-handoff document — NOT a short recap. Optimize for completeness and precision, not brevity. Specifically:
1. Preserve every concrete detail: exact numbers, names, file names, URLs, dates, decisions made and why, and constraints or preferences the user stated.
2. Reproduce code blocks, commands, config, and error messages VERBATIM in fenced code blocks — never paraphrase code.
3. If any message mentions an attached image, document, or file (the transcript will flag these), note explicitly what was attached, its filename if known, and what role it played in the discussion — the other assistant cannot see the original attachment, only what this document says about it.
4. Note what was tried and rejected, not just the final answer, if that context would change how the next assistant should proceed.
5. End with a short "Where this left off" section stating the immediate next step or open question, so the new assistant knows what to do first.
6. Organize with clear section breaks (plain text, no markdown headers). Do not compress just to be shorter — use up to roughly ${tokenBudget} tokens if the material warrants it; a short conversation should still produce a short document, but a long, detailed one should produce a long, detailed one.`;

    let lastErr;
    for (const model of GEMINI_GEN_MODELS) {
        try {
            return await callGenerate(model, prompt, apiKey, 0, tokenBudget);
        } catch (err) {
            console.warn(`[NeuralThreads] Summary model "${model}" failed, trying next: ${err.message}`);
            lastErr = err;
        }
    }
    throw new Error(`All summary models failed. Last error: ${lastErr.message}`);
}

async function callGenerate(model, prompt, apiKey, attempt = 0, maxOutputTokens = MAX_SUMMARY_TOKENS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    // Hard timeout: without this, one stalled Gemini request left the popup
    // stuck on "Exporting…" forever (the .txt had already downloaded, then
    // nothing). On timeout we throw, the next model is tried, and if all
    // fail compressSession falls back to the raw-excerpt summary.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40000);
    let res;
    try {
        res = await fetch(`${url}?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                    maxOutputTokens,
                    temperature: 0.3,
                    thinkingConfig: { thinkingBudget: 0 },
                },
            }),
        });
    } catch (err) {
        throw new Error(err.name === 'AbortError' ? 'Gemini timed out after 40s' : err.message);
    } finally {
        clearTimeout(timer);
    }

    // One quick retry only (was up to 3 with 22s of waiting per model).
    if ((res.status === 429 || res.status === 503) && attempt < 1) {
        await sleep(2000);
        return callGenerate(model, prompt, apiKey, attempt + 1, maxOutputTokens);
    }

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`${res.status}: ${body?.error?.message || 'Unknown'}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) throw new Error('empty response');
    return text.trim();
}

// ─── Tab helpers ──────────────────────────────────────────────────────────────

const PLATFORM_URLS = {
    chatgpt: 'https://chatgpt.com',
    claude: 'https://claude.ai',
    gemini: 'https://gemini.google.com',
};

// URL match patterns used to locate an existing tab for a platform.
const PLATFORM_MATCH = {
    chatgpt: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    claude: ['https://claude.ai/*'],
    gemini: ['https://gemini.google.com/*'],
};

/**
 * Returns the AI platform of the currently active tab, or null.
 */
async function getActiveTabPlatform() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return { success: true, data: null };

    const platform = detectPlatformFromUrl(tab.url);
    return { success: true, data: { platform, tabId: tab.id, url: tab.url } };
}

function detectPlatformFromUrl(url) {
    if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) return 'chatgpt';
    if (url.includes('claude.ai')) return 'claude';
    if (url.includes('gemini.google.com')) return 'gemini';
    return null;
}

/** Find an open tab for a platform (prefers the active one), or null. */
async function findPlatformTab(platform) {
    const patterns = PLATFORM_MATCH[platform];
    if (!patterns) return null;
    const tabs = await chrome.tabs.query({ url: patterns });
    if (tabs.length === 0) return null;
    return tabs.find((t) => t.active) || tabs[0];
}

/**
 * Opens a new tab for the specified platform (or focuses an existing one).
 */
async function openPlatformTab(platform) {
    const targetUrl = PLATFORM_URLS[platform];
    if (!targetUrl) return { success: false, error: `Unknown platform: ${platform}` };

    const existing = await findPlatformTab(platform);
    if (existing) {
        await chrome.tabs.update(existing.id, { active: true });
        await chrome.windows.update(existing.windowId, { focused: true });
        return { success: true, tabId: existing.id, created: false };
    }

    const tab = await chrome.tabs.create({ url: targetUrl });
    return { success: true, tabId: tab.id, created: true };
}

// ─── Tab messaging helpers ─────────────────────────────────────────────────────

/** Promise wrapper around chrome.tabs.sendMessage that surfaces lastError. */
function sendToTab(tabId, message) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(response);
        });
    });
}

/**
 * Programmatically inject the content scripts into a tab that doesn't have
 * them (opened before install/reload). Uses the same file pairs as the
 * manifest's content_scripts. Safe to fail silently — the retry loop reports
 * the real error if this doesn't help.
 */
async function ensureContentScript(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        const url = tab.url || '';
        let platformFile = null;
        if (/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url)) platformFile = 'content/chatgpt.js';
        else if (/^https:\/\/claude\.ai\//.test(url)) platformFile = 'content/claude.js';
        else if (/^https:\/\/gemini\.google\.com\//.test(url)) platformFile = 'content/gemini.js';
        if (!platformFile) return;
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content/attachment-refs.js', 'content/content.js', platformFile],
        });
        try { await chrome.scripting.insertCSS({ target: { tabId }, files: ['styles/inject.css'] }); } catch (_) {}
        console.log('[NeuralThreads] Injected content scripts into tab', tabId);
    } catch (err) {
        console.warn('[NeuralThreads] Manual content-script injection failed:', err.message);
    }
}

/** Retry sendToTab while the content script is still loading (fresh tabs). */
async function sendToTabWithRetry(tabId, message, tries = 10, delay = 700) {
    let lastErr = null;
    let injectedManually = false;
    for (let i = 0; i < tries; i++) {
        try {
            const r = await sendToTab(tabId, message);
            if (r) return r;
        } catch (err) {
            lastErr = err; // "Receiving end does not exist" while content script boots
            // Tabs opened before the extension was installed/reloaded never get
            // the content script, which is what caused "Receiving end does not
            // exist" until the user manually refreshed. After a couple of failed
            // attempts, inject the scripts ourselves (once) instead of asking
            // the user to reload the tab.
            if (!injectedManually && i >= 1) {
                injectedManually = true;
                await ensureContentScript(tabId);
            }
        }
        await sleep(delay);
    }
    if (lastErr) throw lastErr;
    return null;
}

// ─── Full-transcript .txt download ───────────────────────────────────────────

/** Turns a conversation title into a safe filename fragment. */
function slugifyFilename(title) {
    return (title || 'conversation')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'conversation';
}

/** Renders the full raw scrape (every message, unabridged) as plain text. */
function buildTranscriptText(scraped) {
    const header =
        `NeuralThreads export\n` +
        `Platform: ${scraped.platform}\n` +
        `Title: ${scraped.title}\n` +
        `URL: ${scraped.url}\n` +
        `Exported: ${new Date().toISOString()}\n` +
        `${'='.repeat(48)}\n\n`;

    const body = scraped.messages
        .map((m) => `${m.role === 'assistant' ? 'AI' : 'Human'}:\n${m.content}`)
        .join('\n\n');

    return header + body;
}

/**
 * Saves the whole conversation to the user's Downloads folder as a .txt.
 * Runs alongside RAG compression (not awaited by the caller) so it never
 * adds to export time; failures are logged, not fatal to the export.
 *
 * Encoded as a data URI rather than an Object URL — service workers don't
 * reliably support URL.createObjectURL across Chrome versions, and
 * chrome.downloads.download() accepts data: URLs directly.
 */
async function downloadTranscript(scraped) {
    const text = buildTranscriptText(scraped);
    const base64 = btoa(unescape(encodeURIComponent(text)));
    const dataUrl = `data:text/plain;charset=utf-8;base64,${base64}`;
    const filename = `neuralthreads-${scraped.platform}-${slugifyFilename(scraped.title)}.txt`;

    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
}

// ─── Export orchestration ───────────────────────────────────────────────────────

/**
 * Full export pipeline, driven by the popup's "Export This Conversation":
 *   1. Locate the platform's tab
 *   2. Ask its content script to scrape (NT_EXPORT)
 *   3. RAG-compress the messages via Gemini (key stays in the browser)
 *   4. Save locally (which fires cloud sync if enabled)
 */
async function exportSession(platform) {
    const tab = await findPlatformTab(platform);
    if (!tab) {
        return { success: false, error: `No ${platform} tab found. Open a conversation there and try again.` };
    }

    let scrapeRes;
    try {
        scrapeRes = await sendToTabWithRetry(tab.id, { type: 'NT_EXPORT' }, 6, 600);
    } catch (err) {
        return { success: false, error: `Could not read the ${platform} page (${err.message}). Reload the tab and retry.` };
    }
    if (!scrapeRes || !scrapeRes.success) {
        return { success: false, error: scrapeRes?.error || 'Scrape failed — no conversation found.' };
    }

    const scraped = scrapeRes.session;
    if (!scraped?.messages?.length) {
        return { success: false, error: 'No messages found. Make sure a conversation is open.' };
    }

    // Save the full raw transcript as a .txt to Downloads. Fired in parallel
    // with RAG compression below, not awaited — it shouldn't add latency to
    // the export, and a download failure shouldn't fail the export itself.
    downloadTranscript(scraped).catch((err) =>
        console.warn('[NeuralThreads] Transcript .txt download failed:', err.message)
    );

    // Capture the actual photos/documents (bytes) while the summary is written.
    // Runs in parallel: attachment download and Gemini summarisation are independent.
    const sessionId = crypto.randomUUID();
    const capturePromise = captureAttachments({
        platform: scraped.platform,
        tabId: tab.id,
        tabUrl: tab.url || scraped.url,
        refs: scraped.attachmentRefs || [],
        sessionId,
    }).catch((err) => {
        console.error('[NeuralThreads] Attachment capture crashed:', err);
        return { attachments: [], failures: [{ filename: '(all)', reason: `capture crashed: ${err.message}` }], requested: (scraped.attachmentRefs || []).length, notes: [] };
    });

    // RAG compression (requires the user's Gemini key; stays in the browser).
    const comp = await compressSession(scraped.messages, {
        platform: scraped.platform,
        title: scraped.title,
        url: scraped.url,
        attachmentNote: scraped.metadata?.hasAttachments || (scraped.attachmentRefs || []).length
            ? '- Note: this conversation includes image/file attachments and/or generated artifacts (Claude Artifacts, ChatGPT Canvas, etc.), flagged inline in the excerpts as [Attached image: ...] / [Attached file: ...] / [Generated ... artifact ...] markers. The attachments that could be captured are delivered to the next assistant as REAL FILES alongside this summary (a list is appended at the end), so mention what each one was and what role it played, but do not invent its contents. Generated artifacts were NOT captured and must be re-downloaded from the original conversation by the user.'
            : '',
    });
    const cap = await capturePromise;
    if (!comp.success) {
        await deleteAttachments(cap.attachments).catch(() => { });
        return { success: false, error: comp.error };
    }

    const attachments = cap.attachments;
    const imageCount = attachments.filter((a) => a.type === 'image').length;
    const attachmentReport = {
        requested: cap.requested,
        saved: attachments.length,
        failed: cap.failures.length,
        failures: cap.failures.slice(0, 20),
        notes: cap.notes,
    };

    const now = new Date().toISOString();
    const session = {
        id: sessionId,
        platform: scraped.platform,
        title: scraped.title,
        url: scraped.url,
        messages: scraped.messages,       // raw — stays local only
        attachments,                      // metadata only; bytes live in chrome.storage.local under nt_att:<sessionId>:<id>
        attachmentReport,
        summary: comp.summary,            // RAG-compressed (or fallback excerpt) — syncs to cloud
        aiSummary: comp.aiSummary !== false, // false only when we fell back to a raw excerpt
        tokenStats: comp.tokenStats || null, // { originalTokens, summaryTokens, savedTokens, savedPct }
        chunks: comp.chunks || [],        // embeddings — local only (v2 search)
        tags: [],
        metadata: {
            ...(scraped.metadata || {}),
            attachmentCount: attachments.length,
            imageCount,
            documentCount: attachments.length - imageCount,
            attachmentFailures: cap.failures.length,
        },
        exportedAt: Date.now(),
        createdAt: now,
        updatedAt: now,
        synced: false,
        cloudId: null,
    };

    const saveRes = await saveSession(session);
    if (!saveRes.success) {
        await deleteAttachments(attachments).catch(() => { });
        return saveRes;
    }

    // Return the saved session (minus raw messages/chunks, same shape as
    // getSessions()) so the popup can splice it straight into its in-memory
    // list instead of re-reading the entire sessions array from storage.
    const { messages, chunks, images, ...sessionForPopup } = session;
    return { success: true, sessionId: session.id, session: sessionForPopup, warning: comp.warning, attachmentReport };
}

// ─── Inject orchestration ───────────────────────────────────────────────────────

/** Max files per message the target composer accepts (summary file counts as one). */
const PLATFORM_FILE_LIMITS = { claude: 20, chatgpt: 10, gemini: 10 };

/** Plain-text list appended to the summary so the target AI knows what files accompany it. */
function buildAttachmentManifest(selected, skipped) {
    if (!selected.length && !skipped) return '';
    const lines = selected.map((a) => {
        const kind = a.type === 'image' ? 'photo' : 'document';
        const note = a.derivedFromText ? ', text extracted from the original document' : '';
        const from = Number.isInteger(a.messageIndex) ? `, from message ${a.messageIndex + 1}` : '';
        return `- ${a.filename} (${kind}${note}${from})`;
    });
    let out = `\n\n---\nATTACHED FILES (delivered with this summary as real files; open them for their actual content):\n${lines.join('\n')}`;
    if (skipped) out += `\n(${skipped} more file${skipped > 1 ? 's were' : ' was'} not attached because of the platform's per-message file limit.)`;
    return out;
}

/**
 * Opens/focuses the target platform tab and injects the (user-approved) summary
 * into its composer via the content script, together with the session's
 * captured photos and documents. Never submits — the user sends.
 */
async function injectSummaryToPlatform(target, summary, sessionId) {
    if (!summary || !summary.trim()) {
        return { success: false, error: 'No summary text to inject.' };
    }

    // Look up this session's captured attachments (metadata; bytes are read
    // by the content script straight from chrome.storage.local).
    let attachments = [];
    if (sessionId) {
        const store = await chrome.storage.local.get('sessions');
        const session = (store.sessions || []).find((s) => s.id === sessionId);
        attachments = session?.attachments || [];
    }

    const limit = PLATFORM_FILE_LIMITS[target] || 10;
    const selected = attachments.slice(0, Math.max(0, limit - 1));
    const skipped = attachments.length - selected.length;
    const summaryWithManifest = summary.trimEnd() + buildAttachmentManifest(selected, skipped);

    const opened = await openPlatformTab(target);
    if (!opened.success) return opened;

    // A freshly created tab needs longer for its content script to load.
    const tries = opened.created ? 15 : 8;
    try {
        const res = await sendToTabWithRetry(
            opened.tabId,
            {
                type: 'NT_INJECT',
                summary: summaryWithManifest,
                attachments: selected.map(({ key, filename, mime, type }) => ({ key, filename, mime, type })),
            },
            tries,
            800
        );
        if (!res || !res.success) {
            return { success: false, error: res?.error || `Could not inject into ${target}.` };
        }
        return {
            success: true,
            attachmentsRequested: selected.length,
            attachmentsAttached: res.attachmentsAttached || 0,
            attachmentsSkipped: skipped,
            attachMethod: res.method,
            attachErrors: res.errors || [],
        };
    } catch (err) {
        return { success: false, error: `Could not reach the ${target} page (${err.message}). Let it finish loading and try again.` };
    }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getBackendBase() {
    // Allow override from storage (e.g. for self-hosted deployments)
    const store = await chrome.storage.local.get('backend_url');
    return store.backend_url || BACKEND_BASE;
}

async function authSignup({ email, password, name }) {
    try {
        const base = await getBackendBase();
        const res = await fetch(`${base}/api/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, name }),
        });

        const data = await res.json();
        if (!res.ok) return { success: false, error: data.message || 'Signup failed' };

        await storeTokens(data.accessToken, data.refreshToken);
        return { success: true, user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function authLogin({ email, password }) {
    try {
        const base = await getBackendBase();
        const res = await fetch(`${base}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });

        const data = await res.json();
        if (!res.ok) return { success: false, error: data.message || 'Login failed' };

        await storeTokens(data.accessToken, data.refreshToken);
        await maybeScheduleTokenRefresh();
        return { success: true, user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function authLogout() {
    await chrome.storage.local.remove(['access_token', 'refresh_token', 'user']);
    chrome.alarms.clear(ALARM_TOKEN_REFRESH);
    return { success: true };
}

async function getAuthState() {
    const store = await chrome.storage.local.get(['access_token', 'user']);
    return {
        success: true,
        data: {
            isLoggedIn: !!store.access_token,
            user: store.user || null,
        },
    };
}

async function storeTokens(accessToken, refreshToken) {
    await chrome.storage.local.set({
        access_token: accessToken,
        refresh_token: refreshToken,
    });
}

/**
 * Schedules JWT refresh alarm 5 minutes before expiry.
 * Access tokens expire in 15 min by default; refresh at 10 min.
 */
async function maybeScheduleTokenRefresh() {
    const store = await chrome.storage.local.get('access_token');
    if (!store.access_token) return;

    // Schedule refresh every 10 minutes if logged in
    chrome.alarms.create(ALARM_TOKEN_REFRESH, { periodInMinutes: 10 });
}

async function refreshJwt() {
    const store = await chrome.storage.local.get(['refresh_token']);
    if (!store.refresh_token) return;

    try {
        const base = await getBackendBase();
        const res = await fetch(`${base}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: store.refresh_token }),
        });

        if (!res.ok) {
            console.warn('[NeuralThreads] JWT refresh failed, logging out');
            await authLogout();
            return;
        }

        const data = await res.json();
        await storeTokens(data.accessToken, data.refreshToken);
        console.log('[NeuralThreads] JWT refreshed');
    } catch (err) {
        console.warn('[NeuralThreads] JWT refresh error:', err.message);
    }
}

/**
 * Returns the stored access token (for use in cloud API calls).
 */
async function getAccessToken() {
    const store = await chrome.storage.local.get('access_token');
    return store.access_token || null;
}

// ─── Cloud sync ───────────────────────────────────────────────────────────────

/**
 * Syncs a single session's summary to the backend.
 * ONLY the summary is sent — raw messages and chunks stay local.
 */
async function syncSessionToCloud(sessionId) {
    const store = await chrome.storage.local.get('sessions');
    const sessions = store.sessions || [];
    const session = sessions.find((s) => s.id === sessionId);

    if (!session) return { success: false, error: 'Session not found locally' };
    if (!session.summary) return { success: false, error: 'Session has no summary yet' };

    const token = await getAccessToken();
    if (!token) return { success: false, error: 'Not logged in' };

    try {
        const base = await getBackendBase();

        // Cloud payload — NEVER includes raw messages or embeddings
        const cloudPayload = {
            localId: session.id,
            title: session.title,
            platform: session.platform,
            url: session.url,
            summary: session.summary,         // RAG-compressed
            tags: session.tags || [],
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
        };

        const method = session.cloudId ? 'PUT' : 'POST';
        const endpoint = session.cloudId
            ? `${base}/api/sessions/${session.cloudId}`
            : `${base}/api/sessions`;

        const res = await fetch(endpoint, {
            method,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(cloudPayload),
        });

        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.message || `HTTP ${res.status}`);
        }

        const data = await res.json();

        // Update local session with cloud ID and synced flag
        const updatedSessions = sessions.map((s) =>
            s.id === sessionId
                ? { ...s, synced: true, cloudId: data._id || data.cloudId }
                : s
        );
        await chrome.storage.local.set({ sessions: updatedSessions });

        console.log('[NeuralThreads] Session synced to cloud:', sessionId);
        return { success: true, cloudId: data._id || data.cloudId };
    } catch (err) {
        console.error('[NeuralThreads] Cloud sync error:', err.message);
        return { success: false, error: err.message };
    }
}

async function deleteSessionFromCloud(cloudId) {
    const token = await getAccessToken();
    if (!token) return;

    const base = await getBackendBase();
    await fetch(`${base}/api/sessions/${cloudId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
    });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}