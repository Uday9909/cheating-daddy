const { GoogleGenAI, Modality } = require('@google/genai');
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { getSystemPrompt } = require('./prompts');
const {
    getAvailableModel,
    incrementLimitCount,
    getApiKey,
    getGroqApiKey,
    getOpenRouterApiKey,
    getDeepSeekApiKey,
    incrementCharUsage,
    getConfig,
    getPreferences,
} = require('../storage');
const { connectCloud, sendCloudAudio, sendCloudText, sendCloudImage, closeCloud, isCloudActive, setOnTurnComplete } = require('./cloud');
const { startTransportLog, logTransportEvent, closeTransportLog } = require('./transportLogger');

// Lazy-loaded to avoid circular dependency (localai.js imports from gemini.js)
let _localai = null;
function getLocalAi() {
    if (!_localai) _localai = require('./localai');
    return _localai;
}

// Provider mode: 'byok', 'cloud', or 'local'
let currentProviderMode = 'byok';

// Groq conversation history for context
let groqConversationHistory = [];

// Conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let conversationHistory = [];
let screenAnalysisHistory = [];
let currentProfile = null;
let currentCustomPrompt = null;
let isInitializingSession = false;
let currentSystemPrompt = null;

function formatSpeakerResults(results) {
    let text = '';
    for (const result of results) {
        if (result.transcript && result.speakerId) {
            const speakerLabel = result.speakerId === 1 ? 'Interviewer' : 'Candidate';
            text += `[${speakerLabel}]: ${result.transcript}\n`;
        }
    }
    return text;
}

module.exports.formatSpeakerResults = formatSpeakerResults;

// Audio capture variables
let systemAudioProc = null;
let messageBuffer = '';
let groqRequestStartedForTurn = false;

const GROQ_MAX_COMPLETION_TOKENS = 16384;
const GROQ_EMPTY_RESPONSE_MESSAGE =
    'Groq reached the maximum completion-token limit before returning a final answer. Disable thinking in Home → AI responses and try again.';

// Reconnection variables
let isUserClosing = false;
let sessionParams = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

// Build context message for session restoration
function buildContextMessage() {
    const lastTurns = conversationHistory.slice(-20);
    const validTurns = lastTurns.filter(turn => turn.transcription?.trim() && turn.ai_response?.trim());

    if (validTurns.length === 0) return null;

    const contextLines = validTurns.map(turn => `[Interviewer]: ${turn.transcription.trim()}\n[Your answer]: ${turn.ai_response.trim()}`);

    return `Session reconnected. Here's the conversation so far:\n\n${contextLines.join('\n\n')}\n\nContinue from here.`;
}

// Conversation management functions
function initializeNewSession(profile = null, customPrompt = null) {
    currentSessionId = Date.now().toString();
    startTransportLog(currentSessionId);
    currentTranscription = '';
    groqRequestStartedForTurn = false;
    conversationHistory = [];
    screenAnalysisHistory = [];
    groqConversationHistory = [];
    deepseekConversationHistory = [];
    currentProfile = profile;
    currentCustomPrompt = customPrompt;
    console.log('New conversation session started:', currentSessionId, 'profile:', profile);

    // Save initial session with profile context
    if (profile) {
        sendToRenderer('save-session-context', {
            sessionId: currentSessionId,
            profile: profile,
            customPrompt: customPrompt || '',
        });
    }
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);
    console.log('Saved conversation turn:', conversationTurn);

    // Send to renderer to save in IndexedDB
    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function saveScreenAnalysis(prompt, response, model) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const analysisEntry = {
        timestamp: Date.now(),
        prompt: prompt,
        response: response.trim(),
        model: model,
    };

    screenAnalysisHistory.push(analysisEntry);
    console.log('Saved screen analysis:', analysisEntry);

    // Send to renderer to save
    sendToRenderer('save-screen-analysis', {
        sessionId: currentSessionId,
        analysis: analysisEntry,
        fullHistory: screenAnalysisHistory,
        profile: currentProfile,
        customPrompt: currentCustomPrompt,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

async function getEnabledTools() {
    const tools = [];

    // Check if Google Search is enabled (default: true)
    const googleSearchEnabled = await getStoredSetting('googleSearchEnabled', 'true');
    console.log('Google Search enabled:', googleSearchEnabled);

    if (googleSearchEnabled === 'true') {
        tools.push({ googleSearch: {} });
        console.log('Added Google Search tool');
    } else {
        console.log('Google Search tool disabled');
    }

    return tools;
}

async function getStoredSetting(key, defaultValue) {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            // Wait a bit for the renderer to be ready
            await new Promise(resolve => setTimeout(resolve, 100));

            // Try to get setting from renderer process localStorage
            const value = await windows[0].webContents.executeJavaScript(`
                (function() {
                    try {
                        if (typeof localStorage === 'undefined') {
                            console.log('localStorage not available yet for ${key}');
                            return '${defaultValue}';
                        }
                        const stored = localStorage.getItem('${key}');
                        console.log('Retrieved setting ${key}:', stored);
                        return stored || '${defaultValue}';
                    } catch (e) {
                        console.error('Error accessing localStorage for ${key}:', e);
                        return '${defaultValue}';
                    }
                })()
            `);
            return value;
        }
    } catch (error) {
        console.error('Error getting stored setting for', key, ':', error.message);
    }
    console.log('Using default value for', key, ':', defaultValue);
    return defaultValue;
}

// helper to check if groq has been configured
function hasGroqKey() {
    const key = getGroqApiKey();
    return key && key.trim() != '';
}

// helper to check if openrouter has been configured
function hasOpenRouterKey() {
    const key = getOpenRouterApiKey();
    return key && key.trim() != '';
}

// helper to check if deepseek has been configured
function hasDeepSeekKey() {
    const key = getDeepSeekApiKey();
    return key && key.trim() != '';
}

// The live Gemini session is what normally builds the system prompt. When live audio is
// off it never opens, so the HTTP providers (DeepSeek/Groq/OpenRouter) would fall back to
// a bare "helpful assistant" and drop the user's context. Rebuild it from prefs instead.
function ensureContextPrompt() {
    if (getPreferences().liveAudioEnabled !== true) {
        const prefs = getPreferences();
        currentSystemPrompt = getSystemPrompt(prefs.selectedProfile || 'interview', prefs.customPrompt || '', false);
    }
}

function sendFinalTranscriptionToGroq() {
    if (!hasGroqKey() || groqRequestStartedForTurn) {
        return;
    }

    const transcription = currentTranscription.trim();
    if (transcription === '') {
        return;
    }

    groqRequestStartedForTurn = true;
    sendToGroq(transcription);
}

function trimConversationHistoryForGemma(history, maxChars = 42000) {
    if (!history || history.length === 0) return [];
    let totalChars = 0;
    const trimmed = [];

    for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i];
        const turnChars = (turn.content || '').length;

        if (totalChars + turnChars > maxChars) break;
        totalChars += turnChars;
        trimmed.unshift(turn);
    }
    return trimmed;
}

function stripThinkingTags(text) {
    const trimmedStart = text.trimStart();
    if ('<think>'.startsWith(trimmedStart)) {
        return '';
    }

    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
}

function getGroqReasoningOptions(model, disableThinking) {
    if (model.includes('qwen3')) {
        const options = {
            reasoning_format: 'hidden',
        };

        if (disableThinking) {
            options.reasoning_effort = 'none';
        }

        return options;
    }

    if (model.startsWith('openai/gpt-oss-')) {
        return {
            include_reasoning: false,
        };
    }

    return {};
}

// Shared OpenAI-compatible chat completions streaming (used by Groq and OpenRouter)
async function streamOpenAiCompletions({ endpoint, apiKey, model, messages, extraBody = {}, label, prefix, emitToRenderer = true }) {
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages,
            stream: true,
            temperature: 0.7,
            max_completion_tokens: GROQ_MAX_COMPLETION_TOKENS,
            ...extraBody,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`${label} API error:`, response.status, errorText);
        logTransportEvent(`${prefix}.http_error`, {
            status: response.status,
            body: errorText,
        });
        return { ok: false, status: response.status, errorText };
    }

    logTransportEvent(`${prefix}.http_response`, {
        status: response.status,
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let isFirst = true;
    let finishReason = null;

    let sseBuffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        logTransportEvent(`${prefix}.stream_chunk`, { chunk });

        // Network chunks can split mid-line; keep the incomplete tail for the next read
        sseBuffer += chunk;
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop();
        const completeLines = lines.filter(line => line.trim() !== '');

        for (const line of completeLines) {
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
                const json = JSON.parse(data);
                logTransportEvent(`${prefix}.stream_event`, json);
                finishReason = json.choices?.[0]?.finish_reason || finishReason;
                const token = json.choices?.[0]?.delta?.content || '';
                if (token) {
                    fullText += token;
                    if (emitToRenderer) {
                        const displayText = stripThinkingTags(fullText);
                        if (displayText) {
                            sendToRenderer(isFirst ? 'new-response' : 'update-response', displayText);
                            isFirst = false;
                        }
                    }
                }
            } catch (parseError) {
                logTransportEvent(`${prefix}.stream_parse_error`, {
                    data,
                    error: parseError.message,
                });
            }
        }
    }

    return { ok: true, fullText, finishReason };
}

async function sendToGroq(transcription) {
    const groqApiKey = getGroqApiKey();
    if (!groqApiKey) {
        console.log('No Groq API key configured, skipping Groq response');
        return { success: false, error: 'No Groq API key configured' };
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Groq');
        return { success: false, error: 'Empty transcription' };
    }

    const config = getConfig();
    const modelToUse = config.groqModel;

    console.log(`Sending to Groq (${modelToUse}):`, transcription.substring(0, 100) + '...');
    logTransportEvent('groq.text.request', {
        model: modelToUse,
        transcription,
    });

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    if (groqConversationHistory.length > 20) {
        groqConversationHistory = groqConversationHistory.slice(-20);
    }

    try {
        const result = await streamOpenAiCompletions({
            endpoint: 'https://api.groq.com/openai/v1/chat/completions',
            apiKey: groqApiKey,
            model: modelToUse,
            messages: [{ role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' }, ...groqConversationHistory],
            extraBody: getGroqReasoningOptions(modelToUse, config.disableGroqThinking),
            label: 'Groq',
            prefix: 'groq.text',
        });

        if (!result.ok) {
            sendToRenderer('update-status', `Groq error: ${result.status}`);
            return { success: false, error: `Groq error: ${result.status}` };
        }

        const { fullText, finishReason } = result;
        const cleanedResponse = stripThinkingTags(fullText);
        const modelKey = modelToUse.split('/').pop();

        const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
        const historyChars = groqConversationHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
        const inputChars = systemPromptChars + historyChars;
        const outputChars = cleanedResponse.length;

        incrementCharUsage('groq', modelKey, inputChars + outputChars);

        if (cleanedResponse) {
            groqConversationHistory.push({
                role: 'assistant',
                content: cleanedResponse,
            });

            saveConversationTurn(transcription, cleanedResponse);
        } else {
            console.warn(`Groq returned no final answer (${modelToUse})`);
            logTransportEvent('groq.text.empty_response', {
                model: modelToUse,
                fullText,
                finishReason,
            });
            sendToRenderer('new-response', GROQ_EMPTY_RESPONSE_MESSAGE);
            sendToRenderer('update-status', 'Groq reached the completion-token limit');
            return { success: false, error: GROQ_EMPTY_RESPONSE_MESSAGE };
        }

        logTransportEvent('groq.text.completed', {
            model: modelToUse,
            response: cleanedResponse,
        });
        console.log(`Groq response completed (${modelToUse})`);
        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: cleanedResponse, model: modelToUse };
    } catch (error) {
        console.error('Error calling Groq API:', error);
        logTransportEvent('groq.text.error', {
            error: error.message,
            stack: error.stack,
        });
        sendToRenderer('update-status', 'Groq error: ' + error.message);
        return { success: false, error: error.message };
    }
}

async function sendImageToGroq(base64Data, prompt, emitToRenderer = true) {
    const groqApiKey = getGroqApiKey();
    const config = getConfig();
    const model = config.groqImageModel;

    logTransportEvent('groq.image.request', {
        model,
        prompt,
        imageBytes: Buffer.byteLength(base64Data, 'base64'),
    });

    try {
        const result = await streamOpenAiCompletions({
            endpoint: 'https://api.groq.com/openai/v1/chat/completions',
            apiKey: groqApiKey,
            model,
            messages: [
                { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Data}`,
                            },
                        },
                    ],
                },
            ],
            extraBody: getGroqReasoningOptions(model, config.disableGroqThinking),
            label: 'Groq image',
            prefix: 'groq.image',
            emitToRenderer,
        });

        if (!result.ok) {
            return { success: false, error: `Groq error: ${result.status}` };
        }

        const cleanedResponse = stripThinkingTags(result.fullText);
        if (!cleanedResponse) {
            logTransportEvent('groq.image.empty_response', {
                model,
                fullText: result.fullText,
                finishReason: result.finishReason,
            });
            return { success: false, error: GROQ_EMPTY_RESPONSE_MESSAGE };
        }

        saveScreenAnalysis(prompt, cleanedResponse, model);
        logTransportEvent('groq.image.completed', {
            model,
            response: cleanedResponse,
        });
        return { success: true, text: cleanedResponse, model };
    } catch (error) {
        console.error('Error calling Groq image API:', error);
        logTransportEvent('groq.image.error', {
            error: error.message,
            stack: error.stack,
        });
        return { success: false, error: error.message };
    }
}

async function sendToOpenRouter(transcription) {
    const apiKey = getOpenRouterApiKey();
    if (!apiKey) {
        console.log('No OpenRouter API key configured, skipping OpenRouter response');
        return { success: false, error: 'No OpenRouter API key configured' };
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping OpenRouter');
        return { success: false, error: 'Empty transcription' };
    }

    const model = getConfig().openrouterModel;

    console.log(`Sending to OpenRouter (${model}):`, transcription.substring(0, 100) + '...');
    logTransportEvent('openrouter.text.request', {
        model,
        transcription,
    });

    try {
        const result = await streamOpenAiCompletions({
            endpoint: 'https://openrouter.ai/api/v1/chat/completions',
            apiKey,
            model,
            messages: [
                { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
                { role: 'user', content: transcription.trim() },
            ],
            label: 'OpenRouter',
            prefix: 'openrouter.text',
        });

        if (!result.ok) {
            sendToRenderer('update-status', `OpenRouter error: ${result.status}`);
            return { success: false, error: `OpenRouter error: ${result.status}` };
        }

        const cleanedResponse = stripThinkingTags(result.fullText);
        if (!cleanedResponse) {
            console.warn(`OpenRouter returned no final answer (${model})`);
            sendToRenderer('update-status', 'OpenRouter returned an empty response');
            return { success: false, error: 'OpenRouter returned an empty response' };
        }

        saveConversationTurn(transcription, cleanedResponse);
        logTransportEvent('openrouter.text.completed', {
            model,
            response: cleanedResponse,
        });
        console.log(`OpenRouter response completed (${model})`);
        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: cleanedResponse, model };
    } catch (error) {
        console.error('Error calling OpenRouter API:', error);
        sendToRenderer('update-status', 'OpenRouter error: ' + error.message);
        return { success: false, error: error.message };
    }
}

async function sendImageToOpenRouter(base64Data, prompt, emitToRenderer = true) {
    const apiKey = getOpenRouterApiKey();
    const model = getConfig().openrouterImageModel;

    logTransportEvent('openrouter.image.request', {
        model,
        prompt,
        imageBytes: Buffer.byteLength(base64Data, 'base64'),
    });

    try {
        const result = await streamOpenAiCompletions({
            endpoint: 'https://openrouter.ai/api/v1/chat/completions',
            apiKey,
            model,
            messages: [
                { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Data}`,
                            },
                        },
                    ],
                },
            ],
            label: 'OpenRouter image',
            prefix: 'openrouter.image',
            emitToRenderer,
        });

        if (!result.ok) {
            return { success: false, error: `OpenRouter error: ${result.status}` };
        }

        const cleanedResponse = stripThinkingTags(result.fullText);
        if (!cleanedResponse) {
            return { success: false, error: 'OpenRouter returned an empty response' };
        }

        logTransportEvent('openrouter.image.completed', {
            model,
            response: cleanedResponse,
        });
        return { success: true, text: cleanedResponse, model };
    } catch (error) {
        console.error('Error calling OpenRouter image API:', error);
        logTransportEvent('openrouter.image.error', {
            error: error.message,
            stack: error.stack,
        });
        return { success: false, error: error.message };
    }
}

const EXTRACT_TEXT_PROMPT = 'Extract ALL text from this image verbatim, preserving structure. Output only the extracted text.';

async function extractTextFromImage(base64Data) {
    let result;
    if (getApiKey()) {
        // Own Gemini key (free tier) first — avoids OpenRouter credit/rate-limit issues
        result = await sendImageToGeminiHttp(base64Data, EXTRACT_TEXT_PROMPT, false);
    } else if (hasOpenRouterKey()) {
        result = await sendImageToOpenRouter(base64Data, EXTRACT_TEXT_PROMPT, false);
    } else if (hasGroqKey()) {
        result = await sendImageToGroq(base64Data, EXTRACT_TEXT_PROMPT, false);
    } else {
        result = await sendImageToGeminiHttp(base64Data, EXTRACT_TEXT_PROMPT);
    }
    return result && result.success ? result.text : '';
}

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
let deepseekConversationHistory = [];

async function sendToDeepSeek(transcription) {
    const apiKey = getDeepSeekApiKey();
    if (!apiKey) {
        console.log('No DeepSeek API key configured, skipping DeepSeek response');
        return { success: false, error: 'No DeepSeek API key configured' };
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping DeepSeek');
        return { success: false, error: 'Empty transcription' };
    }

    const model = getConfig().deepseekModel;

    console.log(`Sending to DeepSeek (${model}):`, transcription.substring(0, 100) + '...');
    logTransportEvent('deepseek.text.request', {
        model,
        transcription,
    });

    deepseekConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    if (deepseekConversationHistory.length > 20) {
        deepseekConversationHistory = deepseekConversationHistory.slice(-20);
    }

    try {
        const result = await streamOpenAiCompletions({
            endpoint: DEEPSEEK_ENDPOINT,
            apiKey,
            model,
            messages: [{ role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' }, ...deepseekConversationHistory],
            label: 'DeepSeek',
            prefix: 'deepseek.text',
        });

        if (!result.ok) {
            deepseekConversationHistory.pop();
            sendToRenderer('update-status', `DeepSeek error: ${result.status}`);
            return { success: false, error: `DeepSeek error: ${result.status}` };
        }

        const cleanedResponse = stripThinkingTags(result.fullText);
        if (!cleanedResponse) {
            deepseekConversationHistory.pop();
            console.warn(`DeepSeek returned no final answer (${model})`);
            sendToRenderer('update-status', 'DeepSeek returned an empty response');
            return { success: false, error: 'DeepSeek returned an empty response' };
        }

        deepseekConversationHistory.push({
            role: 'assistant',
            content: cleanedResponse,
        });

        saveConversationTurn(transcription, cleanedResponse);
        logTransportEvent('deepseek.text.completed', {
            model,
            response: cleanedResponse,
        });
        console.log(`DeepSeek response completed (${model})`);
        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: cleanedResponse, model };
    } catch (error) {
        deepseekConversationHistory.pop();
        console.error('Error calling DeepSeek API:', error);
        sendToRenderer('update-status', 'DeepSeek error: ' + error.message);
        return { success: false, error: error.message };
    }
}

async function sendImageToDeepSeek(base64Data, prompt, emitToRenderer = true) {
    const apiKey = getDeepSeekApiKey();
    const model = getConfig().deepseekVisionModel;
    if (!apiKey) return { success: false, error: 'No DeepSeek API key configured' };

    logTransportEvent('deepseek.image.request', {
        model,
        imageBytes: Buffer.byteLength(base64Data, 'base64'),
    });

    try {
        const result = await streamOpenAiCompletions({
            endpoint: DEEPSEEK_ENDPOINT,
            apiKey,
            model,
            messages: [
                { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/jpeg;base64,${base64Data}` },
                        },
                    ],
                },
            ],
            label: 'DeepSeek image',
            prefix: 'deepseek.image',
            emitToRenderer,
        });

        if (!result.ok) {
            return { success: false, error: `DeepSeek error: ${result.status}` };
        }

        const cleanedResponse = stripThinkingTags(result.fullText);
        if (!cleanedResponse) {
            return { success: false, error: 'DeepSeek returned an empty response' };
        }

        logTransportEvent('deepseek.image.completed', { model, response: cleanedResponse });
        return { success: true, text: cleanedResponse, model };
    } catch (error) {
        console.error('Error calling DeepSeek image API:', error);
        return { success: false, error: error.message };
    }
}

// Try text providers in priority order, falling back on failure
async function sendTextWithFallback(text) {
    if (hasDeepSeekKey()) {
        const result = await sendToDeepSeek(text);
        if (result.success) return result;
    }
    if (hasGroqKey()) {
        const result = await sendToGroq(text);
        if (result.success) return result;
    }
    if (hasOpenRouterKey()) {
        const result = await sendToOpenRouter(text);
        if (result.success) return result;
    }
    return { success: false, error: 'All text providers failed' };
}

async function processScreenText(combinedPrompt) {
    return sendTextWithFallback(combinedPrompt);
}

async function sendToGemma(transcription) {
    const apiKey = getApiKey();
    if (!apiKey) {
        console.log('No Gemini API key configured');
        return;
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Gemma');
        return;
    }

    console.log('Sending to Gemma:', transcription.substring(0, 100) + '...');

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    const trimmedHistory = trimConversationHistoryForGemma(groqConversationHistory, 42000);

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey });

        const messages = trimmedHistory.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
        }));

        const systemPrompt = currentSystemPrompt || 'You are a helpful assistant.';
        const messagesWithSystem = [
            { role: 'user', parts: [{ text: systemPrompt }] },
            { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
            ...messages,
        ];

        const response = await ai.models.generateContentStream({
            model: 'gemma-4-26b-a4b-it',
            contents: messagesWithSystem,
        });

        let fullText = '';
        let isFirst = true;

        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
        const historyChars = trimmedHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
        const inputChars = systemPromptChars + historyChars;
        const outputChars = fullText.length;

        incrementCharUsage('gemini', 'gemma-4-26b-a4b-it', inputChars + outputChars);

        if (fullText.trim()) {
            groqConversationHistory.push({
                role: 'assistant',
                content: fullText.trim(),
            });

            if (groqConversationHistory.length > 40) {
                groqConversationHistory = groqConversationHistory.slice(-40);
            }

            saveConversationTurn(transcription, fullText);
        }

        console.log('Gemma response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('Error calling Gemma API:', error);
        sendToRenderer('update-status', 'Gemma error: ' + error.message);
    }
}

async function initializeGeminiSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US', isReconnect = false) {
    if (isInitializingSession) {
        console.log('Session initialization already in progress');
        return false;
    }

    // Live audio disabled — skip opening the live session entirely (no connect, no reconnect)
    if (getPreferences().liveAudioEnabled === false) {
        console.log('Live audio disabled — skipping live session');
        return null;
    }

    isInitializingSession = true;
    if (!isReconnect) {
        sendToRenderer('session-initializing', true);
    }

    // Store params for reconnection
    if (!isReconnect) {
        sessionParams = { apiKey, customPrompt, profile, language };
        reconnectAttempts = 0;
    }

    const client = new GoogleGenAI({
        vertexai: false,
        apiKey: apiKey,
        httpOptions: { apiVersion: 'v1alpha' },
    });

    // Get enabled tools first to determine Google Search status
    const enabledTools = await getEnabledTools();
    const googleSearchEnabled = enabledTools.some(tool => tool.googleSearch);

    const systemPrompt = getSystemPrompt(profile, customPrompt, googleSearchEnabled);
    currentSystemPrompt = systemPrompt; // Store for Groq

    // Initialize new conversation session only on first connect
    if (!isReconnect) {
        initializeNewSession(profile, customPrompt);
    }

    try {
        const session = await client.live.connect({
            model: getConfig().geminiLiveModel,
            callbacks: {
                onopen: function () {
                    logTransportEvent('gemini.live.opened', {});
                    sendToRenderer('update-status', 'Live session connected');
                },
                onmessage: function (message) {
                    console.log('----------------', message);
                    logTransportEvent('gemini.live.message', message);

                    // Handle input transcription (what was spoken)
                    if (message.serverContent?.inputTranscription?.results) {
                        currentTranscription += formatSpeakerResults(message.serverContent.inputTranscription.results);
                    } else if (message.serverContent?.inputTranscription?.text) {
                        const text = message.serverContent.inputTranscription.text;
                        if (text.trim() !== '') {
                            currentTranscription += text;
                        }
                    }

                    if (message.serverContent?.inputTranscription) {
                        sendFinalTranscriptionToGroq();
                    }

                    if (!hasGroqKey() && message.serverContent?.outputTranscription?.text) {
                        const isFirstChunk = messageBuffer === '';
                        messageBuffer += message.serverContent.outputTranscription.text;
                        sendToRenderer(isFirstChunk ? 'new-response' : 'update-response', messageBuffer);
                    }

                    if (message.serverContent?.generationComplete) {
                        if (currentTranscription.trim() !== '') {
                            if (!hasGroqKey() && messageBuffer.trim() !== '') {
                                saveConversationTurn(currentTranscription, messageBuffer);
                            }
                            currentTranscription = '';
                        }
                        messageBuffer = '';
                    }

                    if (message.serverContent?.turnComplete) {
                        currentTranscription = '';
                        messageBuffer = '';
                        groqRequestStartedForTurn = false;
                        sendToRenderer('update-status', 'Listening...');
                    }
                },
                onerror: function (e) {
                    console.log('Session error:', e.message);
                    logTransportEvent('gemini.live.error', {
                        error: e.message,
                    });
                    sendToRenderer('update-status', 'Error: ' + e.message);
                },
                onclose: function (e) {
                    console.log('Session closed:', e.reason);
                    logTransportEvent('gemini.live.closed', {
                        reason: e.reason,
                    });

                    // Don't reconnect if user intentionally closed
                    if (isUserClosing) {
                        isUserClosing = false;
                        closeTransportLog();
                        sendToRenderer('update-status', 'Session closed');
                        return;
                    }

                    // Attempt reconnection
                    if (sessionParams && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        attemptReconnect();
                    } else {
                        closeTransportLog();
                        sendToRenderer('update-status', 'Session closed');
                    }
                },
            },
            config: {
                responseModalities: [Modality.AUDIO],
                proactivity: { proactiveAudio: true },
                outputAudioTranscription: {},
                tools: enabledTools,
                // Enable speaker diarization
                inputAudioTranscription: {
                    enableSpeakerDiarization: true,
                    minSpeakerCount: 2,
                    maxSpeakerCount: 2,
                },
                contextWindowCompression: { slidingWindow: {} },
                speechConfig: { languageCode: language },
                systemInstruction: {
                    parts: [{ text: systemPrompt }],
                },
            },
        });

        isInitializingSession = false;
        if (!isReconnect) {
            sendToRenderer('session-initializing', false);
        }
        return session;
    } catch (error) {
        console.error('Failed to initialize Gemini session:', error);
        isInitializingSession = false;
        if (!isReconnect) {
            sendToRenderer('session-initializing', false);
        }
        return null;
    }
}

async function attemptReconnect() {
    reconnectAttempts++;
    console.log(`Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

    // Clear stale buffers
    messageBuffer = '';
    currentTranscription = '';
    // Don't reset groqConversationHistory to preserve context across reconnects

    sendToRenderer('update-status', `Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    // Wait before attempting
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));

    try {
        const session = await initializeGeminiSession(
            sessionParams.apiKey,
            sessionParams.customPrompt,
            sessionParams.profile,
            sessionParams.language,
            true // isReconnect
        );

        if (session && global.geminiSessionRef) {
            global.geminiSessionRef.current = session;

            // Restore context from conversation history via text message
            const contextMessage = buildContextMessage();
            if (contextMessage) {
                try {
                    console.log('Restoring conversation context...');
                    await session.sendRealtimeInput({ text: contextMessage });
                } catch (contextError) {
                    console.error('Failed to restore context:', contextError);
                    // Continue without context - better than failing
                }
            }

            // Don't reset reconnectAttempts here - let it reset on next fresh session
            sendToRenderer('update-status', 'Reconnected! Listening...');
            console.log('Session reconnected successfully');
            return true;
        }
    } catch (error) {
        console.error(`Reconnection attempt ${reconnectAttempts} failed:`, error);
    }

    // If we still have attempts left, try again
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        return attemptReconnect();
    }

    // Max attempts reached - notify frontend
    console.log('Max reconnection attempts reached');
    sendToRenderer('reconnect-failed', {
        message: 'Tried 3 times to reconnect. Must be upstream/network issues. Try restarting or download updated app from site.',
    });
    sessionParams = null;
    return false;
}

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        console.log('Checking for existing SystemAudioDump processes...');

        // Kill any existing SystemAudioDump processes
        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', code => {
            if (code === 0) {
                console.log('Killed existing SystemAudioDump processes');
            } else {
                console.log('No existing SystemAudioDump processes found');
            }
            resolve();
        });

        killProc.on('error', err => {
            console.log('Error checking for existing processes (this is normal):', err.message);
            resolve();
        });

        // Timeout after 2 seconds
        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture(geminiSessionRef) {
    if (process.platform !== 'darwin') return false;

    // Kill any existing SystemAudioDump processes first
    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
        },
    };

    systemAudioProc = spawn(systemAudioPath, [], spawnOptions);

    if (!systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);

    systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;

            if (currentProviderMode === 'cloud') {
                sendCloudAudio(monoChunk);
            } else if (currentProviderMode === 'local') {
                getLocalAi().processLocalAudio(monoChunk);
            } else {
                const base64Data = monoChunk.toString('base64');
                sendAudioToGemini(base64Data, geminiSessionRef);
            }

            if (process.env.DEBUG_AUDIO) {
                console.log(`Processed audio chunk: ${chunk.length} bytes`);
                saveDebugAudio(monoChunk, 'system_audio');
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }
}

async function sendAudioToGemini(base64Data, geminiSessionRef) {
    if (!geminiSessionRef.current) return;

    try {
        process.stdout.write('.');
        await geminiSessionRef.current.sendRealtimeInput({
            audio: {
                data: base64Data,
                mimeType: 'audio/pcm;rate=24000',
            },
        });
    } catch (error) {
        console.error('Error sending audio to Gemini:', error);
    }
}

async function sendImageToGeminiHttp(base64Data, prompt, emitToRenderer = true) {
    // Get available model based on rate limits
    const model = getAvailableModel();

    const apiKey = getApiKey();
    if (!apiKey) {
        return { success: false, error: 'No API key configured' };
    }

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey });

        const contents = [
            {
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: base64Data,
                },
            },
            { text: prompt },
        ];

        console.log(`Sending image to ${model} (streaming)...`);
        const response = await ai.models.generateContentStream({
            model: model,
            contents: contents,
        });

        // Increment count after successful call
        incrementLimitCount(model);

        // Stream the response
        let fullText = '';
        let isFirst = true;
        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                if (emitToRenderer) {
                    // Send to renderer - new response for first chunk, update for subsequent
                    sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                    isFirst = false;
                }
            }
        }

        console.log(`Image response completed from ${model}`);

        // Save screen analysis to history
        saveScreenAnalysis(prompt, fullText, model);

        return { success: true, text: fullText, model: model };
    } catch (error) {
        console.error('Error sending image to Gemini HTTP:', error);
        return { success: false, error: error.message };
    }
}

function setupGeminiIpcHandlers(geminiSessionRef) {
    // Store the geminiSessionRef globally for reconnection access
    global.geminiSessionRef = geminiSessionRef;

    ipcMain.handle('initialize-cloud', async (event, token, profile, userContext) => {
        try {
            currentProviderMode = 'cloud';
            initializeNewSession(profile);
            setOnTurnComplete((transcription, response) => {
                saveConversationTurn(transcription, response);
            });
            sendToRenderer('session-initializing', true);
            await connectCloud(token, profile, userContext);
            sendToRenderer('session-initializing', false);
            return true;
        } catch (err) {
            console.error('[Cloud] Init error:', err);
            currentProviderMode = 'byok';
            sendToRenderer('session-initializing', false);
            return false;
        }
    });

    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        currentProviderMode = 'byok';
        const session = await initializeGeminiSession(apiKey, customPrompt, profile, language);
        if (session) {
            geminiSessionRef.current = session;
            return true;
        }
        return false;
    });

    ipcMain.handle('initialize-local', async (event, localLlmModel, whisperModel, profile, customPrompt) => {
        currentProviderMode = 'local';
        const success = await getLocalAi().initializeLocalSession(localLlmModel, whisperModel, profile, customPrompt);
        if (!success) {
            currentProviderMode = 'byok';
        }
        return success;
    });

    ipcMain.handle('cancel-local-initialization', async () => {
        const cancelled = await getLocalAi().cancelLocalInitialization();
        if (cancelled) {
            currentProviderMode = 'byok';
        }
        return cancelled;
    });

    ipcMain.handle('send-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write('.');
            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending system audio:', error);
            return { success: false, error: error.message };
        }
    });

    // Handle microphone audio on a separate channel
    ipcMain.handle('send-mic-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write(',');
            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending mic audio:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-image-content', async (event, { data, prompt }) => {
        ensureContextPrompt();
        try {
            if (!data || typeof data !== 'string') {
                console.error('Invalid image data received');
                return { success: false, error: 'Invalid image data' };
            }

            const buffer = Buffer.from(data, 'base64');

            if (buffer.length < 1000) {
                console.error(`Image buffer too small: ${buffer.length} bytes`);
                return { success: false, error: 'Image buffer too small' };
            }

            process.stdout.write('!');

            if (currentProviderMode === 'cloud') {
                const sent = sendCloudImage(data);
                if (!sent) {
                    return { success: false, error: 'Cloud connection not active' };
                }
                return { success: true, model: 'cloud' };
            }

            if (currentProviderMode === 'local') {
                const result = await getLocalAi().sendLocalImage(data, prompt);
                return result;
            }

            // One-shot vision: DeepSeek answers the screenshot directly (no separate OCR step)
            if (getPreferences().liveAudioEnabled !== true && hasDeepSeekKey() && prompt && prompt.trim()) {
                return await sendImageToDeepSeek(data, prompt);
            }

            // Live audio off: extract screen text, then answer through the text provider (OpenRouter → Groq)
            if (getPreferences().liveAudioEnabled !== true && (hasOpenRouterKey() || hasGroqKey())) {
                const extractedText = await extractTextFromImage(data);
                sendToRenderer('extracted-text', extractedText);
                if (!extractedText || !extractedText.trim()) {
                    return { success: false, error: 'Screen text extraction failed — no text returned. Check the extraction model and retry.' };
                }
                const combinedPrompt = `${prompt || 'Analyze the screen'}\n\nScreen text:\n${extractedText}`;
                const result = await processScreenText(combinedPrompt);
                return { success: true, model: result.model || '', extractedText };
            }

            const result = hasGroqKey() ? await sendImageToGroq(data, prompt) : await sendImageToGeminiHttp(data, prompt);
            return result;
        } catch (error) {
            console.error('Error sending image:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { success: false, error: 'Invalid text message' };
        }

        ensureContextPrompt();

        if (currentProviderMode === 'cloud') {
            try {
                console.log('Sending text to cloud:', text);
                sendCloudText(text.trim());
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud text:', error);
                return { success: false, error: error.message };
            }
        }

        if (currentProviderMode === 'local') {
            try {
                console.log('Sending text to local Llama:', text);
                return await getLocalAi().sendLocalText(text.trim());
            } catch (error) {
                console.error('Error sending local text:', error);
                return { success: false, error: error.message };
            }
        }

        // Without live audio, answer through the configured HTTP text provider (DeepSeek → Groq → OpenRouter)
        if (getPreferences().liveAudioEnabled !== true && (hasDeepSeekKey() || hasGroqKey() || hasOpenRouterKey())) {
            const result = await sendTextWithFallback(text.trim());
            return result && result.success ? { success: true } : { success: false, error: (result && result.error) || 'Text provider failed' };
        }

        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };

        try {
            console.log('Sending text message:', text);

            if (hasGroqKey()) {
                groqRequestStartedForTurn = true;
                sendToGroq(text.trim());
            }

            await geminiSessionRef.current.sendRealtimeInput({ text: text.trim() });
            return { success: true };
        } catch (error) {
            console.error('Error sending text:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async event => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture(geminiSessionRef);
            return { success };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async event => {
        try {
            stopMacOSAudioCapture();

            if (currentProviderMode === 'cloud') {
                closeCloud();
                currentProviderMode = 'byok';
                closeTransportLog();
                return { success: true };
            }

            if (currentProviderMode === 'local') {
                getLocalAi().closeLocalSession();
                currentProviderMode = 'byok';
                closeTransportLog();
                return { success: true };
            }

            // Set flag to prevent reconnection attempts
            isUserClosing = true;
            sessionParams = null;

            // Cleanup session
            if (geminiSessionRef.current) {
                await geminiSessionRef.current.close();
                geminiSessionRef.current = null;
            } else {
                closeTransportLog();
            }

            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    // Conversation history IPC handlers
    ipcMain.handle('get-current-session', async event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting current session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            console.error('Error starting new session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-google-search-setting', async (event, enabled) => {
        try {
            console.log('Google Search setting updated to:', enabled);
            // The setting is already saved in localStorage by the renderer
            // This is just for logging/confirmation
            return { success: true };
        } catch (error) {
            console.error('Error updating Google Search setting:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    initializeGeminiSession,
    getEnabledTools,
    getStoredSetting,
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    stopMacOSAudioCapture,
    sendAudioToGemini,
    sendImageToGeminiHttp,
    setupGeminiIpcHandlers,
    formatSpeakerResults,
};
