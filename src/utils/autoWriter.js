const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

let activeWriteProcess = null;
// The identity of currentRun is the guard: a stale run's finalizer only clears
// state when it is still the active run, so restart races can't strand pause.
let currentRun = null;
let nextRunId = 0;

/**
 * Unescapes standard HTML entities that may be produced by LLMs.
 */
function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

/**
 * Detects programming language heuristics from code contents when a language tag is missing.
 */
function detectLanguageFromCode(code) {
    if (!code || typeof code !== 'string') return '';
    // Look for Python keywords and structures without braces
    const hasPythonDefs = /^\s*(def\s+\w+|class\s+\w+|import\s+\w+|from\s+\w+\s+import|elif\s+|if\s+__name__\s*==)/m.test(code);
    const hasPythonComments = /^\s*#[^!]/m.test(code);
    const hasCurlyBraces = /[{};]/.test(code);
    if (hasPythonDefs || (hasPythonComments && !hasCurlyBraces)) {
        return 'python';
    }
    // C / C++ / Java / C#
    if (/#include\s*<|std::|public\s+static\s+void\s+main|System\.out\.println|int\s+main\s*\(/.test(code)) {
        return 'cpp';
    }
    // JavaScript / TypeScript
    if (/\b(const|let|var|function|console\.log|export|import\s+.*\s+from)\b/.test(code)) {
        return 'javascript';
    }
    return '';
}

/**
 * Extracts clean code or subjective text from an AI response.
 *
 * @param {string} rawText - Raw markdown text from AI response
 * @param {Object} options - Extraction options
 * @param {string} [options.contentType='auto'] - 'auto' | 'code' | 'subjective' | 'full'
 * @returns {{ type: string, text: string, hasCode: boolean, language: string }}
 */
function extractWritableContent(rawText, options = {}) {
    if (!rawText || typeof rawText !== 'string') {
        return { type: 'empty', text: '', hasCode: false, language: '' };
    }

    const { contentType = 'auto' } = options;
    const trimmed = rawText.trim();

    // Check for markdown code blocks: ```lang ... ```
    const codeBlockRegex = /```([a-zA-Z0-9_#+-]*)\r?\n([\s\S]*?)```/g;
    const codeBlocks = [];
    let match;

    while ((match = codeBlockRegex.exec(trimmed)) !== null) {
        const lang = (match[1] || '').trim();
        const code = match[2] || '';
        codeBlocks.push({ lang, code });
    }

    const hasCode = codeBlocks.length > 0;

    // 1. Force FULL mode if requested
    if (contentType === 'full') {
        return {
            type: 'full',
            text: trimmed,
            hasCode,
            language: hasCode ? codeBlocks[0].lang : '',
        };
    }

    // 2. CODE mode (explicitly requested or auto-detected with code blocks)
    if (contentType === 'code' || (contentType === 'auto' && hasCode)) {
        if (hasCode) {
            // Find the most substantial code block (solution code)
            let bestBlock = codeBlocks[0];
            for (let i = 1; i < codeBlocks.length; i++) {
                if (codeBlocks[i].code.length > bestBlock.code.length) {
                    bestBlock = codeBlocks[i];
                }
            }

            // Clean code: trim outer newlines, decode entities, preserve indentation
            let cleanCode = decodeHtmlEntities(bestBlock.code).replace(/^\r?\n+|\r?\n+$/g, '');
            const lang = (bestBlock.lang || detectLanguageFromCode(cleanCode) || '').trim();
            if (options.stripComments !== false) {
                cleanCode = stripCommentsFromCode(cleanCode, lang);
            }
            return {
                type: 'code',
                text: cleanCode,
                hasCode: true,
                language: lang,
            };
        } else if (contentType === 'code') {
            let cleanCode = decodeHtmlEntities(trimmed).replace(/^\r?\n+|\r?\n+$/g, '');
            const lang = (options.language || detectLanguageFromCode(cleanCode) || '').trim();
            if (options.stripComments !== false) {
                cleanCode = stripCommentsFromCode(cleanCode, lang);
            }
            return {
                type: 'code',
                text: cleanCode,
                hasCode: false,
                language: lang,
            };
        }
    }

    // 3. SUBJECTIVE mode (or auto when no code blocks)
    return {
        type: 'subjective',
        text: cleanSubjectiveText(trimmed),
        hasCode: false,
        language: '',
    };
}

/**
 * Strips comments from source code to ensure typed code is 100% clean,
 * concise, and without comment clutter.
 *
 * @param {string} code - Raw code
 * @param {string} language - Programming language (e.g., 'python', 'java', 'javascript')
 * @returns {string} Code with comments removed
 */
function stripCommentsFromCode(code, language = '') {
    if (!code || typeof code !== 'string') return '';
    let lang = (language || '').toLowerCase().trim();
    if (!lang) {
        lang = detectLanguageFromCode(code);
    }
    const isPythonOrRubyOrShell = ['python', 'py', 'ruby', 'rb', 'bash', 'sh', 'shell', 'perl', 'r'].includes(lang);

    let result = '';
    const len = code.length;
    let i = 0;

    if (!isPythonOrRubyOrShell) {
        // C, C++, Java, JavaScript, TypeScript, C#, Go, Rust, Swift, PHP, etc.
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let inBacktick = false;

        while (i < len) {
            const ch = code[i];
            const next = i + 1 < len ? code[i + 1] : '';

            // Handle escapes inside strings
            if ((inSingleQuote || inDoubleQuote || inBacktick) && ch === '\\') {
                result += ch + (next || '');
                i += 2;
                continue;
            }

            // String delimiters
            if (!inDoubleQuote && !inBacktick && ch === "'") {
                inSingleQuote = !inSingleQuote;
                result += ch;
                i++;
                continue;
            }
            if (!inSingleQuote && !inBacktick && ch === '"') {
                inDoubleQuote = !inDoubleQuote;
                result += ch;
                i++;
                continue;
            }
            if (!inSingleQuote && !inDoubleQuote && ch === '`') {
                inBacktick = !inBacktick;
                result += ch;
                i++;
                continue;
            }

            // Outside strings, check for comments
            if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
                // Single-line comment: //
                if (ch === '/' && next === '/') {
                    i += 2;
                    while (i < len && code[i] !== '\n') {
                        i++;
                    }
                    continue;
                }

                // Multi-line block comment: /* ... */
                if (ch === '/' && next === '*') {
                    i += 2;
                    while (i < len && !(code[i] === '*' && i + 1 < len && code[i + 1] === '/')) {
                        i++;
                    }
                    i += 2; // skip */
                    continue;
                }
            }

            result += ch;
            i++;
        }
    } else {
        // Python, Ruby, Shell, etc.
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let inTripleSingle = false;
        let inTripleDouble = false;

        while (i < len) {
            // Check shebang on first line
            if (i === 0 && code.startsWith('#!')) {
                while (i < len && code[i] !== '\n') {
                    result += code[i];
                    i++;
                }
                continue;
            }

            const ch = code[i];
            const next = i + 1 < len ? code[i + 1] : '';
            const next2 = i + 2 < len ? code[i + 2] : '';

            // Triple quotes
            if (!inSingleQuote && !inDoubleQuote) {
                if (!inTripleDouble && ch === "'" && next === "'" && next2 === "'") {
                    inTripleSingle = !inTripleSingle;
                    result += "'''";
                    i += 3;
                    continue;
                }
                if (!inTripleSingle && ch === '"' && next === '"' && next2 === '"') {
                    inTripleDouble = !inTripleDouble;
                    result += '"""';
                    i += 3;
                    continue;
                }
            }

            if (!inTripleSingle && !inTripleDouble) {
                // Escapes
                if ((inSingleQuote || inDoubleQuote) && ch === '\\') {
                    result += ch + (next || '');
                    i += 2;
                    continue;
                }

                if (!inDoubleQuote && ch === "'") {
                    inSingleQuote = !inSingleQuote;
                    result += ch;
                    i++;
                    continue;
                }
                if (!inSingleQuote && ch === '"') {
                    inDoubleQuote = !inDoubleQuote;
                    result += ch;
                    i++;
                    continue;
                }

                if (!inSingleQuote && !inDoubleQuote && ch === '#') {
                    while (i < len && code[i] !== '\n') {
                        i++;
                    }
                    continue;
                }
            }

            result += ch;
            i++;
        }
    }

    return result
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Strips raw markdown syntax from subjective responses so they type out naturally.
 *
 * @param {string} text - Raw markdown text
 * @returns {string} Clean natural text
 */
function cleanSubjectiveText(text) {
    if (!text) return '';

    let cleaned = decodeHtmlEntities(text);

    // Remove code block wrappers if any remain
    cleaned = cleaned.replace(/```[a-zA-Z0-9_#+-]*\r?\n([\s\S]*?)```/g, '$1');

    // Remove conversational preambles
    cleaned = cleaned.replace(
        /^(?:here\s+is\s+(?:the\s+)?(?:answer|solution|response|explanation)|sure[!,.]*|below\s+is\s+the\s+solution)[^:\n]*:\s*/i,
        ''
    );

    // Remove markdown headers: # Header -> Header
    cleaned = cleaned.replace(/^#{1,6}\s+(.*)$/gm, '$1');

    // Remove bold and italic markers: **word** -> word, *word* -> word, __word__ -> word
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
    cleaned = cleaned.replace(/__([^_]+)__/g, '$1');
    cleaned = cleaned.replace(/(^|[^\*])\*([^*]+)\*([^\*]|$)/g, '$1$2$3');

    // Remove inline code ticks: `code` -> code
    cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

    // Remove markdown links: [label](url) -> label
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // Remove blockquote markers: > quote -> quote
    cleaned = cleaned.replace(/^>\s+/gm, '');

    // Remove horizontal rules
    cleaned = cleaned.replace(/^[-*_]{3,}\s*$/gm, '');

    // Strip stray Time/Space complexity footer blocks from subjective responses
    cleaned = cleaned.replace(/(?:\r?\n)+\s*(?:[-*]\s*)?(?:\*\*)?(?:Time|Space)\s+Complexity(?:\*\*)?[\s\S]*$/i, '');

    // Normalize multiple consecutive blank lines to at most two
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
}

/**
 * Formats code for realistic typing into modern web code editors (Monaco, Ace, CodeMirror).
 * Web editors automatically indent when Enter is pressed after '{' or indentation.
 * Removing leading whitespace prevents progressive double-indentation drift.
 * Python/Ruby/YAML are preserved because indentation is syntax.
 *
 * @param {string} code - Clean code
 * @param {string} language - Programming language
 * @returns {string} Code formatted for editor typing
 */
function formatCodeForEditorTyping(code, language = '') {
    if (!code || typeof code !== 'string') return '';
    let lang = (language || '').toLowerCase().trim();
    if (!lang) {
        lang = detectLanguageFromCode(code);
    }
    const isIndentationSensitive = ['python', 'py', 'ruby', 'rb', 'yaml', 'yml'].includes(lang);

    if (isIndentationSensitive) {
        return code.replace(/\t/g, '    ').trimEnd();
    }

    return code
        .split('\n')
        .map(line => line.trimStart())
        .join('\n')
        .trimEnd();
}

/**
 * Calculates typing delay and jitter in milliseconds based on requested speed or WPM.
 * Standard typing definition: 1 word = 5 characters.
 * 150 words per minute = 150 * 5 = 750 characters/minute = 80ms per character.
 *
 * @param {Object} options - Speed options
 * @returns {{ delayMs: number, jitterMs: number }}
 */
function calculateSpeedSettings(options = {}) {
    let speed = options.speed;
    let delayMs = 80; // 150 words per minute default (60,000 / (150 * 5) = 80ms)
    let jitterMs = 20;

    if (options.wpm && Number.isFinite(Number(options.wpm))) {
        const wpm = Math.max(10, Math.min(1000, Number(options.wpm)));
        delayMs = Math.max(2, Math.round(12000 / wpm));
        jitterMs = Math.min(30, Math.round(delayMs * 0.25));
    } else if (speed === '150wpm' || speed === '150' || speed === 150) {
        delayMs = 80;
        jitterMs = 20;
    } else if (typeof speed === 'number' || (typeof speed === 'string' && /^\d+$/.test(speed))) {
        const wpm = Math.max(10, Math.min(1000, Number(speed)));
        delayMs = Math.max(2, Math.round(12000 / wpm));
        jitterMs = Math.min(30, Math.round(delayMs * 0.25));
    } else if (speed === 'slow' || speed === 'human') {
        delayMs = 110;
        jitterMs = 50;
    } else if (speed === 'realistic') {
        delayMs = 65;
        jitterMs = 30;
    } else if (speed === 'fast') {
        delayMs = 25;
        jitterMs = 10;
    } else if (speed === 'turbo') {
        delayMs = 2;
        jitterMs = 1;
    } else {
        // default: 150 words per minute
        delayMs = 80;
        jitterMs = 20;
    }

    return { delayMs, jitterMs };
}

/**
 * Starts auto-writing text to the active target application.
 *
 * @param {string} text - The text to write
 * @param {Object} options - Auto-write options
 * @param {string} [options.mode='type'] - 'type' | 'paste'
 * @param {string|number} [options.speed='150wpm'] - '150wpm' | 'slow' | 'realistic' | 'fast' | 'turbo' | number
 * @param {number} [options.wpm] - Explicit words per minute (e.g. 150)
 * @param {number} [options.startDelayMs=500] - Delay in ms before typing starts
 * @param {Function} [onProgress] - Callback for progress updates: ({ percent, status }) => void
 * @returns {Promise<{ success: boolean, cancelled?: boolean, error?: string }>}
 */
async function startAutoWrite(text, options = {}, onProgress = () => {}) {
    if (!text || !text.trim()) {
        console.warn('[AutoWriter] Cannot start: No text content provided');
        return { success: false, error: 'No content to write' };
    }

    if (currentRun) {
        stopAutoWrite();
        await new Promise(resolve => setTimeout(resolve, 150));
    }

    const run = { id: ++nextRunId, paused: false, tempFile: null };
    currentRun = run;
    // Strict requirement: Always use simulated keystrokes in a background process; NEVER use copy-paste
    const mode = 'type';
    const speed = options.speed || '150wpm';
    const startDelayMs = options.startDelayMs !== undefined ? options.startDelayMs : 500;

    const { delayMs, jitterMs } = calculateSpeedSettings({ ...options, speed });

    console.log(
        `[AutoWriter] Starting auto-write: ${text.length} chars (mode=${mode}, speed=${speed}, delay=${delayMs}ms, startDelay=${startDelayMs}ms)`
    );

    // Typing mode (keystroke simulation)
    try {
        // Prepare text for typing mode: trim progressive indent for C-like languages in web editors
        let textToWrite = text;
        if (mode === 'type' && options.smartIndent !== false) {
            const lang = options.language || '';
            const isCode = options.contentType === 'code' || options.hasCode || /[{};]/.test(text);
            if (isCode) {
                textToWrite = formatCodeForEditorTyping(text, lang);
            }
        }

        const tempFile = path.join(os.tmpdir(), `bsdk_autowrite_${run.id}_${Date.now()}.txt`);
        run.tempFile = tempFile;
        fs.writeFileSync(tempFile, textToWrite, { encoding: 'utf8', mode: 0o600 });

        // A pause raised inside the typing script (hold-Option) must show up in the main state too.
        const handleProgress = progress => {
            if (progress.status === 'Paused') {
                run.paused = true;
            } else if (typeof progress.status === 'string' && progress.status.startsWith('Typing')) {
                run.paused = false;
            }
            onProgress(progress);
        };

        let result;
        if (process.platform === 'win32') {
            result = await executeWindowsScript(tempFile, { mode: 'type', delayMs, jitterMs, startDelayMs }, handleProgress);
        } else if (process.platform === 'darwin') {
            result = await executeMacOSScript(tempFile, textToWrite, { mode: 'type', delayMs, jitterMs, startDelayMs }, handleProgress);
        } else {
            result = await executeLinuxScript(textToWrite, { mode: 'type', delayMs, startDelayMs }, handleProgress);
        }

        console.log('[AutoWriter] Typing completed with result:', result);
        return result;
    } catch (error) {
        console.error('[AutoWriter] Typing execution error:', error);
        return { success: false, error: error.message };
    } finally {
        if (currentRun === run) {
            cleanupRun(run);
            currentRun = null;
        }
    }
}

/**
 * Executes the native PowerShell automation script on Windows.
 */
function executeWindowsScript(tempFilePath, opts, onProgress) {
    return new Promise(resolve => {
        const scriptPath = path.join(__dirname, 'scripts', 'autowrite-win.ps1').replace('app.asar', 'app.asar.unpacked');

        const args = [
            '-WindowStyle',
            'Hidden',
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
            '-Mode',
            'type',
            '-StartDelayMs',
            String(opts.startDelayMs || 0),
            '-ParentPid',
            String(process.pid),
            '-TextFile',
            tempFilePath,
            '-DelayMs',
            String(opts.delayMs || 110),
            '-JitterMs',
            String(opts.jitterMs || 50),
        ];

        const child = spawn('powershell.exe', args, {
            windowsHide: true,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        activeWriteProcess = child;
        let wasCancelled = false;

        child.stdout.on('data', data => {
            const output = data.toString();
            const lines = output.split(/[\r\n]+/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (line.startsWith('PROGRESS:')) {
                    const percent = parseInt(line.replace('PROGRESS:', '').trim(), 10);
                    if (!isNaN(percent)) {
                        onProgress({ percent, status: `Typing... ${percent}%` });
                    }
                } else if (trimmed === 'PAUSED') {
                    onProgress({ status: 'Paused' });
                } else if (trimmed === 'RESUMED') {
                    onProgress({ status: 'Typing...' });
                } else if (trimmed === 'CANCELLED') {
                    wasCancelled = true;
                    onProgress({ percent: 0, status: 'Cancelled' });
                } else if (trimmed === 'DONE') {
                    onProgress({ percent: 100, status: 'Complete' });
                }
            }
        });

        child.stderr.on('data', data => {
            console.warn('[AutoWriter] Script warning:', data.toString());
        });

        child.on('close', code => {
            if (activeWriteProcess === child) activeWriteProcess = null;
            if (code === 0 && !wasCancelled) {
                resolve({ success: true });
            } else {
                resolve({ success: false, cancelled: wasCancelled || !currentRun, code });
            }
        });

        child.on('error', err => {
            if (activeWriteProcess === child) activeWriteProcess = null;
            resolve({ success: false, error: err.message });
        });
    });
}

/**
 * Executes typing or paste automation on macOS via osascript/JXA.
 */
function executeMacOSScript(tempFilePath, text, opts, onProgress = () => {}) {
    return new Promise(resolve => {
        let stderrTail = '';
        const startDelayMs = opts.startDelayMs || 500;
        const delayMs = opts.delayMs || 80;
        const jitterMs = opts.jitterMs || 20;

        if (opts.mode === 'paste') {
            const startDelaySec = startDelayMs / 1000;
            const script = `delay ${startDelaySec}\ntell application "System Events" to keystroke "v" using command down`;
            const child = spawn('osascript', ['-e', script]);
            activeWriteProcess = child;
            child.on('close', code => {
                if (activeWriteProcess === child) activeWriteProcess = null;
                if (code === 0) {
                    onProgress({ percent: 100, status: 'Complete' });
                    resolve({ success: true });
                } else {
                    resolve({ success: false, cancelled: !currentRun, code });
                }
            });
            child.on('error', err => {
                if (activeWriteProcess === child) activeWriteProcess = null;
                resolve({ success: false, error: err.message });
            });
            return;
        }

        // Native JXA runner that simulates typing with delay, respects pause/resume, and reports progress
        const jxaRunner = `
function run(argv) {
    var filePath = argv[0];
    var delayMs = parseInt(argv[1], 10) || 80;
    var jitterMs = parseInt(argv[2], 10) || 20;
    var startDelayMs = parseInt(argv[3], 10) || 500;

    ObjC.import("Foundation");
    ObjC.import("unistd");

    if (startDelayMs > 0) {
        $.usleep(startDelayMs * 1000);
    }

    var fm = $.NSFileManager.defaultManager;
    var pausePath = filePath + ".pause";

    var text = "";
    if (fm.fileExistsAtPath(filePath)) {
        text = $.NSString.stringWithContentsOfFileEncodingError(filePath, $.NSUTF8StringEncoding, null).js || "";
    }

    if (!text || text.length === 0) {
        console.log("PROGRESS:100");
        console.log("DONE");
        return;
    }

    var sys = Application("System Events");
    var total = text.length;
    var lastProgress = 0;

    // Pause control that needs no global shortcut and no Esc/Command:
    // hold Option alone (it types nothing) for ~600ms to toggle pause.
    ObjC.import("CoreGraphics");
    var optionWasDown = false;
    var optionHeldMs = 0;
    var optionPaused = false;

    function optionHeld() {
        return $.CGEventSourceKeyState(1, 58) || $.CGEventSourceKeyState(1, 61);
    }

    function pollPauseKey(ms) {
        if (optionHeld()) {
            if (optionWasDown) {
                optionHeldMs += ms;
            } else {
                optionWasDown = true;
                optionHeldMs = 0;
            }
            if (optionHeldMs >= 600) {
                optionPaused = !optionPaused;
                optionHeldMs = -1e9;
            }
        } else {
            optionWasDown = false;
            optionHeldMs = 0;
        }
    }

    function waitWhilePaused() {
        if (!optionPaused && !fm.fileExistsAtPath(pausePath)) return;
        console.log("PAUSED");
        while (optionPaused || fm.fileExistsAtPath(pausePath)) {
            pollPauseKey(50);
            $.usleep(50000);
        }
        console.log("RESUMED");
    }

    for (var i = 0; i < total; i++) {
        waitWhilePaused();

        var c = text[i];
        if (c === "\\r") continue;

        var isBlockOpen = false;
        if (c === "{" || c === "(" || c === "[") {
            for (var k = i + 1; k < total; k++) {
                var nextChar = text[k];
                if (nextChar === " " || nextChar === "\\t") continue;
                if (nextChar === "\\n" || nextChar === "\\r") isBlockOpen = true;
                break;
            }
        }

        try {
            if (c === "\\n") {
                sys.keyCode(36);
            } else if (c === "\\t") {
                sys.keyCode(48);
            } else {
                sys.keystroke(c);
                if (isBlockOpen) {
                    $.usleep(15000); // 15ms for web editor auto-close handler to execute
                    sys.keyCode(117); // forward delete (del) removes editor-inserted ghost closing bracket
                }
            }
        } catch (e) {}

        var percent = Math.floor(((i + 1) / total) * 100);
        if (percent >= lastProgress + 5 || i === total - 1) {
            lastProgress = percent;
            console.log("PROGRESS:" + percent);
        }

        var wait = delayMs;
        if (jitterMs > 0) {
            wait += Math.floor(Math.random() * (jitterMs + 1));
        }
        if (c === "\\n") {
            wait += 150 + Math.floor(Math.random() * 150);
        } else if (c === ";" || c === "{" || c === "}") {
            wait += 50 + Math.floor(Math.random() * 50);
        }

        // Slice the inter-character wait so a pause press is never missed.
        var waitLeft = wait;
        while (waitLeft > 0) {
            var slice = Math.min(20, waitLeft);
            pollPauseKey(slice);
            if (optionPaused || fm.fileExistsAtPath(pausePath)) {
                waitWhilePaused();
            }
            $.usleep(slice * 1000);
            waitLeft -= slice;
        }
    }

    console.log("DONE");
}
`;

        const child = spawn('osascript', [
            '-l',
            'JavaScript',
            '-e',
            jxaRunner,
            tempFilePath,
            String(delayMs),
            String(jitterMs),
            String(startDelayMs),
        ]);
        activeWriteProcess = child;
        let wasCancelled = false;

        const handleOutput = data => {
            const output = data.toString();
            const lines = output.split(/[\r\n]+/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('PROGRESS:')) {
                    const percent = parseInt(trimmed.substring(9), 10);
                    if (!isNaN(percent)) {
                        onProgress({ percent, status: `Typing ${percent}%` });
                    }
                } else if (trimmed === 'PAUSED') {
                    onProgress({ percent: undefined, status: 'Paused' });
                } else if (trimmed === 'RESUMED') {
                    onProgress({ status: 'Typing...' });
                } else if (trimmed === 'CANCELLED') {
                    wasCancelled = true;
                } else if (trimmed === 'DONE') {
                    onProgress({ percent: 100, status: 'Complete' });
                }
            }
        };

        child.stdout.on('data', handleOutput);
        child.stderr.on('data', data => {
            stderrTail = (stderrTail + data.toString()).slice(-500);
            handleOutput(data);
        });

        child.on('close', code => {
            if (activeWriteProcess === child) activeWriteProcess = null;
            if (code === 0) {
                onProgress({ percent: 100, status: 'Complete' });
                resolve({ success: true });
            } else {
                resolve({
                    success: false,
                    cancelled: wasCancelled || !currentRun,
                    code,
                    error: stderrTail.trim() || `osascript exited with code ${code}`,
                });
            }
        });

        child.on('error', err => {
            if (activeWriteProcess === child) activeWriteProcess = null;
            resolve({ success: false, error: err.message });
        });
    });
}

/**
 * Executes typing or paste automation on Linux via xdotool or clipboard.
 */
function executeLinuxScript(text, opts, onProgress = () => {}) {
    return new Promise(resolve => {
        const startDelaySec = (opts.startDelayMs || 500) / 1000;

        const cmd = opts.mode === 'paste' ? 'xdotool' : 'xdotool';
        const args =
            opts.mode === 'paste'
                ? ['sleep', String(startDelaySec), 'key', 'ctrl+v']
                : ['sleep', String(startDelaySec), 'type', '--delay', String(opts.delayMs || 110), text];

        const child = spawn(cmd, args);
        activeWriteProcess = child;

        child.on('close', code => {
            if (activeWriteProcess === child) activeWriteProcess = null;
            if (code === 0) {
                onProgress({ percent: 100, status: 'Complete' });
                resolve({ success: true });
            } else {
                resolve({ success: false, error: 'Keystroke simulation tool xdotool failed or is not installed' });
            }
        });

        child.on('error', err => {
            if (activeWriteProcess === child) activeWriteProcess = null;
            resolve({ success: false, error: err.message });
        });
    });
}

/**
 * Immediately stops any ongoing auto-write operation.
 */
function stopAutoWrite() {
    const run = currentRun;
    currentRun = null;
    if (activeWriteProcess) {
        try {
            if (process.platform === 'win32' && activeWriteProcess.pid) {
                const { execSync } = require('child_process');
                try {
                    execSync(`taskkill /PID ${activeWriteProcess.pid} /T /F`, { stdio: 'ignore' });
                } catch (_) {}
            }
            activeWriteProcess.kill('SIGKILL');
        } catch (_) {}
        activeWriteProcess = null;
    }
    cleanupRun(run);
    return true;
}

function cleanupRun(run) {
    if (!run || !run.tempFile) return;
    const tempFile = run.tempFile;
    run.tempFile = null;
    try {
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
        const pauseFile = `${tempFile}.pause`;
        if (fs.existsSync(pauseFile)) {
            fs.unlinkSync(pauseFile);
        }
    } catch (_) {}
}

/**
 * Pauses active auto-writing in place.
 */
function pauseAutoWrite() {
    const run = currentRun;
    if (!run || run.paused || !run.tempFile) return false;
    try {
        fs.writeFileSync(`${run.tempFile}.pause`, '1');
    } catch (_) {
        return false;
    }
    run.paused = true;
    return true;
}

/**
 * Resumes paused auto-writing from the exact current character.
 */
function resumeAutoWrite() {
    const run = currentRun;
    if (!run || !run.paused || !run.tempFile) return false;
    try {
        const pauseFile = `${run.tempFile}.pause`;
        if (fs.existsSync(pauseFile)) {
            fs.unlinkSync(pauseFile);
        }
    } catch (_) {
        return false;
    }
    run.paused = false;
    return true;
}

/**
 * Returns whether auto-writing is currently active.
 */
function isAutoWriting() {
    return Boolean(currentRun);
}

/**
 * Returns whether auto-writing is currently paused.
 */
function isAutoWritePaused() {
    return Boolean(currentRun && currentRun.paused);
}

module.exports = {
    extractWritableContent,
    cleanSubjectiveText,
    stripCommentsFromCode,
    formatCodeForEditorTyping,
    detectLanguageFromCode,
    decodeHtmlEntities,
    calculateSpeedSettings,
    startAutoWrite,
    stopAutoWrite,
    pauseAutoWrite,
    resumeAutoWrite,
    isAutoWriting,
    isAutoWritePaused,
};
