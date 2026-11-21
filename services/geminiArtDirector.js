// ═══════════════════════════════════════════════════════════════
// GEMINI TYPESETTER  (geminiArtDirector.js)
//
// The title is NOT rewritten, with ONE exception: when it is too long for the
// design (more than GEMINI_DIRECTOR_MAX_WORDS words, default 18), Gemini writes a
// SHORT, meaning-preserving version (about 13 words). That rewrite is checked hard
// (no new numbers, no new English words, same script, most words must come from
// the original) and is dropped if it fails - then the original title is used.
// Titles that are not too long keep every word exactly as written.
//
// For the crimson news poster (photo on top, BIG YELLOW headline,
// glowing divider, WHITE outlined sub-lines) Gemini decides:
//
//   1. LAYOUT  which words are the YELLOW headline, which words are the WHITE
//              sub-lines, and where each block breaks into lines.
//   2. FOCUS   the point of the photo that must stay visible when cropped.
//
// SAFETY: Gemini answers with NUMBERS ONLY (word counts per line).
// The text is always rebuilt from your own title words, so nothing Gemini
// types can ever reach the poster. If the numbers are invalid (or Gemini is
// unavailable) the poster uses its own safe local logic.
//
// getDirection() returns null on ANY problem. It never throws.
//
// ENV:
//   GEMINI_API_KEY            one key, or several separated by commas
//   GEMINI_DIRECTOR_ENABLED   "false" switches Gemini off completely
//   GEMINI_DIRECTOR_LAYOUT    "false" = Gemini may not choose the yellow/white split
//   GEMINI_DIRECTOR_SHORTEN   "false" = never shorten long titles
//   GEMINI_DIRECTOR_MAX_WORDS    longer titles get shortened, default 18
//   GEMINI_DIRECTOR_TARGET_WORDS wanted length of the short title, default 13
//   newsItem.aiShorten = false   never shorten this title
//   newsItem.maxWords  = number  per-title limit instead of the env value
//   GEMINI_DIRECTOR_MODELS    default "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash,gemini-3.8-flash"
//   GEMINI_DIRECTOR_TIMEOUT_MS  per request, default 30000
//   GEMINI_DIRECTOR_TOTAL_MS    all models together, default 75000
//   GEMINI_DIRECTOR_SEND_IMAGE  "false" = text only (no photo focus)
// ═══════════════════════════════════════════════════════════════

const crypto = require("crypto");
const fs     = require("fs");
try { require("dotenv").config(); } catch { /* dotenv optional here */ }

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Layout limits (they only shape line breaks; the words never change).
const HEAD_MAX_LINES = 5;   // yellow block
const SUB_MAX_LINES  = 3;   // white block
const LINE_MAX_WORDS = 4;
const LINE_MAX_CHARS = 34;  // a multi-word line longer than this is rejected
const TOTAL_BUDGET_MS = Number(process.env.GEMINI_DIRECTOR_TOTAL_MS) || 75000;

// ── Config helpers ───────────────────────────────────────────
function getKeys() {
  return (process.env.GEMINI_API_KEY || "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k && !/PASTE_YOUR_KEY/i.test(k));
}

function getModels() {
  const list = (process.env.GEMINI_DIRECTOR_MODELS ||
    "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash,gemini-3.8-flash")
    .split(",").map((m) => m.trim()).filter(Boolean);
  return list.length ? list : ["gemini-3.5-flash-lite"];
}

function isEnabled() {
  return process.env.GEMINI_DIRECTOR_ENABLED !== "false" && getKeys().length > 0;
}

// ── Cool-downs: stop hammering a key/model that is rate-limited ──
const cooldownUntil = new Map(); // "key|model" -> epoch ms
const deadModels    = new Map(); // model -> epoch ms (404 / unsupported)

function pairAvailable(key, model) {
  const now = Date.now();
  return (cooldownUntil.get(`${key}|${model}`) || 0) <= now &&
         (deadModels.get(model) || 0) <= now;
}

function parseRetryMs(errBody, headers) {
  try {
    for (const d of errBody?.error?.details || []) {
      if (d.retryDelay) {
        const s = parseFloat(String(d.retryDelay).replace("s", ""));
        if (!Number.isNaN(s)) return Math.ceil(s * 1000);
      }
    }
  } catch { /* ignore */ }
  const ra = headers?.get?.("retry-after");
  if (ra && !Number.isNaN(Number(ra))) return Number(ra) * 1000;
  return null;
}

function isRateLimit(status, body) {
  const msg = String(body?.error?.message || "").toLowerCase();
  const st  = String(body?.error?.status  || "");
  return status === 429 || st === "RESOURCE_EXHAUSTED" ||
         msg.includes("quota") || msg.includes("rate limit");
}

// ── Small result cache (same title + photo + mode = same direction) ──
const CACHE_MAX = 300;
const cache = new Map();

function cacheGet(k) { return cache.get(k) || null; }
function cacheSet(k, v) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, v);
}

// ── Input helpers ────────────────────────────────────────────
function getTitleText(newsItem) {
  if (Array.isArray(newsItem.titleLines) && newsItem.titleLines.length) {
    return newsItem.titleLines
      .map((l) => (typeof l === "string" ? l : l?.text))
      .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }
  return String(newsItem.title || "").replace(/\s+/g, " ").trim();
}

// True when the caller supplies the lower (white) text themselves
function hasExplicitSub(newsItem) {
  const s = newsItem.subtitle || newsItem.subTitleLines;
  return Array.isArray(s) ? s.some(Boolean) : Boolean(s && String(s).trim());
}

// May Gemini choose the yellow/white split + line breaks?
// Not when the caller already decided (subtitle, fixed titleLines, "|" in the title).
function layoutAllowed(newsItem) {
  if (process.env.GEMINI_DIRECTOR_LAYOUT === "false") return false;
  if (newsItem.aiRewrite === false || newsItem.autoTiers === false) return false;
  if (hasExplicitSub(newsItem)) return false;
  if (Array.isArray(newsItem.titleLines) && newsItem.titleLines.length) return false;
  if (String(newsItem.title || "").includes("|")) return false;
  return true;
}

async function loadImageBuffer(image) {
  if (Buffer.isBuffer(image)) return image;
  if (typeof image !== "string") throw new Error("unsupported image input");
  if (image.startsWith("data:")) {
    return Buffer.from(image.slice(image.indexOf(",") + 1), "base64");
  }
  if (/^https?:\/\//i.test(image)) {
    const res = await fetch(image, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching news image`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFileSync(image);
}

// Small JPEG for the model (cheap + fast)
async function prepareImage(image) {
  const sharp = require("sharp");
  const raw = await loadImageBuffer(image);
  return sharp(raw)
    .rotate()
    .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
}

// ── Prompt + schema ──────────────────────────────────────────
// modes = { layout:boolean, focus:boolean }
function buildPrompt({ title, titleTokens, photoRatio, modes }) {
  const numbered = titleTokens.map((w, i) => `${i + 1}. ${w}`).join("\n");
  const total = titleTokens.length;

  const lines = [
    "You are the TYPESETTER of a Malayalam (Kerala) news channel's social-media posters.",
    "You do NOT write or edit news and you never output any title words. You only answer with NUMBERS that say how the given words are split and broken into lines.",
  ];

  if (modes.layout) {
    lines.push(
      "Poster layout: a dark crimson poster. The news photo fills the TOP of the poster and melts into the dark background. Under it the headline is set in two blocks, both centred:",
      "   1. YELLOW block = the BIG headline, 3 to 5 lines, every line the SAME font size. It is the eye-catcher that a viewer reads first.",
      "   2. A glowing red divider line.",
      "   3. WHITE block = a smaller sub-headline with a black outline, 1 to 2 lines. It adds the extra detail, the reaction, the person or the outcome.",
      "IMPORTANT: the font size is chosen so that the LONGEST line of a block fills the poster width. Malayalam words are long, so every line holds only 1 to 2 words (3 only when they are very short). A line that is much shorter than its neighbours looks weak, so keep the lines of a block about equal in width."
    );
  }

  lines.push(
    "",
    "STORY TITLE:",
    title,
    "",
    `THE TITLE AS ${total} NUMBERED WORDS (in order):`,
    numbered,
    "",
    "Do:"
  );

  let n = 1;

  if (modes.layout) {
    lines.push(
      `${n++}. SPLIT THE TITLE BY MEANING into two consecutive parts:`,
      "   - YELLOW part = the main statement, the strongest hook (who did what / the key quote). It uses the FIRST words of the list. It is usually about two thirds of the title.",
      "   - WHITE part = the closing clause: the reason, the person speaking, the reaction, the result. It uses ALL the remaining words, usually 2 to 6 words.",
      "   - Read the whole title first and find the point where the first thought is FINISHED and a new thought STARTS. Typical boundaries: the end of a quotation, a ; or : or . or ? or !, a comma that closes a full clause, or a finished verb followed by a new subject.",
      "   - Decide by MEANING only. Do NOT cut by length. BOTH parts must make sense when read alone (no dangling fragment).",
      "   - Never cut inside a name, a number, a quotation, or between a noun and the word that describes it.",
      "   - Only if the whole title is truly ONE single thought with no closing clause, put ALL words in the YELLOW part and leave the WHITE part empty.",
      `${n++}. BREAK each part into LINES:`,
      "   - YELLOW part: 3 or 4 lines (2 only if the title is very short, 5 only if it is very long). WHITE part: 1 or 2 lines (3 at most for a very long title). The WHOLE poster should have 6 lines or fewer.",
      `   - 1 to 2 words per line (at most ${LINE_MAX_WORDS}). Aim for lines of about 10 to 22 characters, and make all lines of a block about EQUAL in width.`,
      "   - Break at natural phrase boundaries (a noun with its describing word, a verb with its object, an opening quote mark with the word it belongs to). Never end a line on a lone connector word. Keep a number with the word it counts (for example \"1000 രൂപ\" stays together).",
      "HOW TO ANSWER the layout (NUMBERS ONLY, never words):",
      "   - headLineWordCounts = for each yellow line from top to bottom, how many words it contains.",
      "   - subLineWordCounts  = for each white line from top to bottom, how many words it contains (empty list if no white part).",
      `   - ALL numbers together must add up to exactly ${total}, because every word is used once, in order: the yellow lines take words 1, 2, 3 ... and the white lines take the words after them.`,
      "   - Example for a 8-word title: headLineWordCounts [1,2,1,1], subLineWordCounts [1,2]  (1+2+1+1+1+2 = 8)."
    );
  }

  if (modes.focus) {
    lines.push(
      `${n++}. focusX / focusY: where the main subject of the attached photo is (face, person, vehicle, key object), as fractions of the photo from the top-left corner (0 to 1). The photo fills the TOP of the poster as a band of about ${photoRatio}:1 (width:height) and is cropped to that shape. Pick the point that must stay clearly visible; faces should be kept. If the subject is centred, use 0.5 and 0.5.`
    );
  }

  lines.push("", "Return only the JSON object.");
  return lines.join("\n");
}

function buildSchema(modes) {
  const properties = {};
  const required = [];

  if (modes.focus) {
    properties.focusX = { type: "number" };
    properties.focusY = { type: "number" };
    required.push("focusX", "focusY");
  }
  if (modes.layout) {
    properties.headLineWordCounts = { type: "array", items: { type: "integer" } };
    properties.subLineWordCounts  = { type: "array", items: { type: "integer" } };
    required.push("headLineWordCounts", "subLineWordCounts");
  }
  return { type: "object", properties, required };
}

// ── One request ──────────────────────────────────────────────
async function callGemini(key, model, prompt, imgBuf, schema, timeoutOverride) {
  const timeoutMs = timeoutOverride || Number(process.env.GEMINI_DIRECTOR_TIMEOUT_MS) || 30000;

  const parts = [{ text: prompt }];
  if (imgBuf) {
    parts.push({ inline_data: { mime_type: "image/jpeg", data: imgBuf.toString("base64") } });
  }

  const generationConfig = {
    temperature: 0.2, // typesetting needs accuracy, not creativity
    // Gemini 3.x models always think and thinking counts as output, so give them room
    maxOutputTokens: /gemini-2\.5/.test(model) ? 2000 : 4000,
    responseMimeType: "application/json",
    responseSchema: schema,
  };
  // 2.5 models "think" by default; this is a small task, so switch it off
  if (/gemini-2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const res = await fetch(`${API_BASE}/${model}:generateContent`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body:    JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
    signal:  AbortSignal.timeout(timeoutMs),
  });

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }

  if (!res.ok) {
    const err = new Error(`Gemini HTTP ${res.status}: ${json?.error?.message || res.statusText}`);
    err.status      = res.status;
    err.rateLimited = isRateLimit(res.status, json);
    err.retryMs     = parseRetryMs(json, res.headers);
    throw err;
  }

  const text = (json?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "").join("").trim();
  if (!text) {
    const reason = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason || "empty response";
    throw new Error(`Gemini returned no text (${reason})`);
  }
  return text;
}

// ═══════════════════════════════════════════════════════════════
// VALIDATION  (the title must come back word for word)
// ═══════════════════════════════════════════════════════════════

const clamp01  = (n) => Math.min(1, Math.max(0, n));
const tokensOf = (text) => String(text).split(/\s+/).filter(Boolean);

// A number must never be cut by a line break
const badNumberCut = (line) => /\d,$/.test(line) || /^,\d/.test(line);

// The model answers with word COUNTS per line. The lines are cut from the
// ORIGINAL title words, so no word can ever change. Returns
// {headLines, subLines} or null.
function rebuildFromCounts(headC, subC, titleTokens) {
  if (!Array.isArray(headC) || !Array.isArray(subC)) return null;
  const toInts = (arr) => arr.map((n) => Math.round(Number(n)));
  const head = toInts(headC);
  const sub  = toInts(subC);
  if (!head.length) return null;
  if (head.length > HEAD_MAX_LINES || sub.length > SUB_MAX_LINES) return null;

  const all = [...head, ...sub];
  if (all.some((c) => !Number.isFinite(c) || c < 1 || c > LINE_MAX_WORDS)) return null;
  if (all.reduce((a, b) => a + b, 0) !== titleTokens.length) return null;

  let pos = 0;
  const rebuilt = all.map((c) => {
    const line = titleTokens.slice(pos, pos + c).join(" ");
    pos += c;
    return line;
  });

  if (rebuilt.some(badNumberCut)) return null;
  if (rebuilt.some((l) => tokensOf(l).length > 1 && Array.from(l).length > LINE_MAX_CHARS)) return null;

  const headLines = rebuilt.slice(0, head.length);
  const subLines  = rebuilt.slice(head.length);

  if (subLines.length) {
    const headWords = headLines.join(" ").split(" ").length;
    const subWords  = subLines.join(" ").split(" ").length;
    if (headWords < 3 || subWords < 2) return null;
  }
  return { headLines, subLines };
}

function sanitize(raw, titleTokens, modes) {
  let obj;
  try {
    obj = JSON.parse(String(raw).replace(/```json|```/gi, "").trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  const out = {};

  if (modes.focus) {
    const fx = Number(obj.focusX), fy = Number(obj.focusY);
    if (Number.isFinite(fx) && Number.isFinite(fy)) {
      out.focus = { x: clamp01(fx), y: clamp01(fy) };
    }
  }

  if (modes.layout) {
    const r = rebuildFromCounts(obj.headLineWordCounts, obj.subLineWordCounts, titleTokens);
    if (r) {
      out.headLines = r.headLines;
      out.subLines  = r.subLines;
    }
  }

  return Object.keys(out).length ? out : null;
}

// Does this plan contain everything that was asked for?
function isComplete(p, modes) {
  if (!p) return false;
  if (modes.layout && !p.headLines) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════
// SHORTENING  (only for titles that are too long for the design)
// ═══════════════════════════════════════════════════════════════

const MALAYALAM_RE  = /[ഀ-ൿ]/;
const ALLOWED_CHARS = /^[ഀ-ൿ‌‍A-Za-z0-9\s.,:;!?'"‘’“”()\-–—&%₹/]+$/;

function shortenLimits(newsItem) {
  const max    = Number(newsItem.maxWords) || Number(process.env.GEMINI_DIRECTOR_MAX_WORDS) || 18;
  const target = Number(process.env.GEMINI_DIRECTOR_TARGET_WORDS) || 13;
  return { max, target: Math.max(6, Math.min(target, max - 2)) };
}

// Not when the caller decided the text (subtitle, titleLines, "|" in the title)
function shortenAllowed(newsItem, opts) {
  if (opts.shorten === false || opts.layout === false) return false;
  if (process.env.GEMINI_DIRECTOR_SHORTEN === "false") return false;
  if (newsItem.aiShorten === false) return false;
  return layoutAllowed(newsItem);
}

function buildShortenPrompt(title, target) {
  return [
    "You are the HEADLINE EDITOR of a Malayalam (Kerala) news channel's social-media posters.",
    `The headline below is too long for the poster design: the poster shows about ${target} words in big letters. Rewrite it as a SHORT headline of ${Math.max(5, target - 3)} to ${target} words that keeps the full meaning of the story.`,
    "",
    "ORIGINAL HEADLINE:",
    title,
    "",
    "Rules:",
    "- Same language and script as the original (Malayalam stays Malayalam). Use ONLY facts that are in the original. Never add a new fact, name, number, claim or opinion.",
    "- Keep what matters most: WHO (person / organisation, names written exactly as in the original), WHAT happened, the key number, the key quote. Keep every number exactly as written.",
    "- Drop the secondary details, background, repeated information and filler words.",
    "- It must read like a natural, grammatical, COMPLETE headline (not a cut-off sentence). If the original is a quotation followed by the speaker, keep the key of the quote and the speaker.",
    "- Shape: a strong main statement first, then, if useful, a short closing clause (the reaction, the speaker, the result). The poster shows the main statement in big yellow letters and the closing clause in smaller white letters.",
    "- Use the words of the original wherever possible. No emojis, no hashtags, no line breaks.",
    "",
    'Answer with the JSON object {"headline": "..."} only.',
  ].join("\n");
}

const _digits = (t) => String(t).replace(/(\d),(?=\d)/g, "$1").match(/\d+/g) || [];
const _latin  = (t) => (String(t).match(/[A-Za-z]{2,}/g) || []).map((x) => x.toLowerCase());
const _stem   = (w) =>
  Array.from(String(w).replace(/[^ഀ-ൿA-Za-z0-9]/g, "")).slice(0, 4).join("").toLowerCase();

// Returns the cleaned short headline, or null when it cannot be trusted.
function validateShortTitle(raw, original, target) {
  const h = String(raw || "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  if (!h) return null;

  const hTok = tokensOf(h);
  const oTok = tokensOf(original);
  if (hTok.length < 4 || hTok.length > target + 2 || hTok.length >= oTok.length) return null;
  if (!ALLOWED_CHARS.test(h)) return null;
  if (MALAYALAM_RE.test(original) && !MALAYALAM_RE.test(h)) return null;

  // nothing new: no new numbers, no new English words
  const oDigits = new Set(_digits(original));
  if (_digits(h).some((d) => !oDigits.has(d))) return null;
  const oLatin = new Set(_latin(original));
  if (_latin(h).some((w) => !oLatin.has(w))) return null;

  // most words must come from the original (compared by their first letters,
  // because Malayalam words change their endings)
  const oStems = new Set(oTok.map(_stem).filter(Boolean));
  const shared = hTok.filter((w) => oStems.has(_stem(w))).length;
  if (shared / hTok.length < 0.5) return null;

  return h;
}

// Pause / skip a key or model after an error (same rules as the layout request)
function noteError(e, key, model) {
  if (e.rateLimited) {
    const wait = e.retryMs && e.retryMs <= 10 * 60 * 1000 ? e.retryMs + 1000 : 30 * 60 * 1000;
    cooldownUntil.set(`${key}|${model}`, Date.now() + wait);
    console.warn(`[Director] Rate limit on ${model} — paused ${Math.round(wait / 1000)}s`);
  } else if (e.status === 500 || e.status === 502 || e.status === 503 || e.status === 504) {
    cooldownUntil.set(`${key}|${model}`, Date.now() + 20 * 1000);
    console.warn(`[Director] ${model} overloaded (${e.status}) — trying next model`);
  } else if (e.status === 404 || e.status === 400) {
    deadModels.set(model, Date.now() + 10 * 60 * 1000);
    console.warn(`[Director] ${model} unavailable: ${e.message}`);
  } else {
    console.warn(`[Director] ${model} failed: ${e.message} — trying next model`);
  }
}

// Asks Gemini for a short version of a too-long title. Returns the validated
// short title, or null (then the original title is used).
async function shortenTitle(title, newsItem, opts) {
  const { target } = shortenLimits(newsItem);

  const cacheKey = crypto.createHash("sha1").update(`short-v1|${target}|${title}`).digest("hex");
  const hit = cacheGet(cacheKey);
  if (hit) return hit.text;

  const prompt = buildShortenPrompt(title, target);
  const schema = { type: "object", properties: { headline: { type: "string" } }, required: ["headline"] };
  const keys   = getKeys();
  const models = getModels();
  const budget = Number(opts.totalMs) || TOTAL_BUDGET_MS;
  const startedAt = Date.now();

  outer:
  for (const model of models) {
    for (const key of keys) {
      if (!pairAvailable(key, model)) continue;
      if (Date.now() - startedAt > budget) break outer;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const note = "\n\nYour previous answer was rejected. Check: it must be shorter than the original, " +
            `4 to ${target + 2} words, the same language, no new numbers or English words, and mostly the original's own words.`;
          const text = await callGemini(key, model, attempt ? prompt + note : prompt, null, schema, opts.timeoutMs);
          let obj = null;
          try { obj = JSON.parse(String(text).replace(/```json|```/gi, "").trim()); } catch { /* retry */ }
          const out = validateShortTitle(obj && obj.headline, title, target);
          if (out) {
            console.log(`[Director] ✂️ ${model}: title shortened ${tokensOf(title).length} → ${tokensOf(out).length} words`);
            cacheSet(cacheKey, { text: out });
            return out;
          }
          console.warn(`[Director] ${model}: shortened title rejected${attempt ? "" : " — retrying"}`);
        }
      } catch (e) {
        noteError(e, key, model);
        if (e.rateLimited) continue;      // next key
        continue outer;                   // next model
      }
    }
  }
  return null;
}

/**
 * Ask Gemini how to typeset the title (yellow / white split, line breaks, photo focus).
 * The title words are never changed.
 *
 * @param {object} newsItem  same object that goes to createNewsPoster
 * @param {object} [opts]
 * @param {string}  [opts.photoRatio="1.38"]  shape of the photo band (width:height)
 * @param {boolean} [opts.layout]     false = do not ask for the yellow/white split
 *                                    (default: allowed unless the item/env forbids it)
 * @param {boolean} [opts.focus=true]       false = do not ask for the photo focus
 * @param {boolean} [opts.sendImage=true]   false = never send the photo
 * @param {number}  [opts.totalMs]    time budget for all models together
 * @param {number}  [opts.timeoutMs]  time limit for one request
 * @param {boolean} [opts.shorten]    false = never shorten a long title
 * @returns {Promise<null | {
 *   shortTitle?: string, originalTitle?: string,   // only when the title was too long
 *   focus?: {x:number, y:number},
 *   headLines?: string[], subLines?: string[]|null,
 *   headText?: string, subText?: string, rewritten?: boolean,
 * }>}
 */
async function getDirection(newsItem, opts = {}) {
  try {
    if (!isEnabled() || newsItem.aiDirector === false) return null;

    const photoRatio = opts.photoRatio || "1.38";
    const originalTitle = getTitleText(newsItem);
    if (!originalTitle) return null;

    // Too long for the design? Let Gemini write a short, meaning-preserving version.
    let title      = originalTitle;
    let shortTitle = null;
    if (shortenAllowed(newsItem, opts) &&
        tokensOf(originalTitle).length > shortenLimits(newsItem).max) {
      shortTitle = await shortenTitle(originalTitle, newsItem, opts);
      if (shortTitle) title = shortTitle;
    }
    const shortInfo = shortTitle ? { shortTitle, originalTitle } : null;

    const titleTokens = tokensOf(title);

    const wantLayout = opts.layout === false ? false : layoutAllowed(newsItem);
    const wantFocus  = opts.focus !== false;

    // Photo (optional, used for the crop focus)
    let imgBuf = null;
    if (wantFocus && opts.sendImage !== false &&
        process.env.GEMINI_DIRECTOR_SEND_IMAGE !== "false" && newsItem.image) {
      try {
        imgBuf = await prepareImage(newsItem.image);
      } catch (e) {
        console.warn("[Director] Photo not sent (focus stays centred):", e.message);
      }
    }

    const modes = { layout: wantLayout, focus: !!imgBuf };

    // Nothing to ask for
    if (!modes.layout && !modes.focus) return shortInfo;

    const totalBudget = Number(opts.totalMs) || TOTAL_BUDGET_MS;

    // "v13-poster2" = prompt version. Change it to redo cached titles.
    const modeKey  = `${modes.layout ? "L" : "-"}${modes.focus ? "F" : "-"}`;
    const cacheKey = crypto.createHash("sha1")
      .update("v13-poster2|").update(title).update("|").update(modeKey)
      .update("|").update(imgBuf ? crypto.createHash("sha1").update(imgBuf).digest("hex") : "no-img")
      .digest("hex");

    let plan = cacheGet(cacheKey);
    if (!plan) {
      const prompt = buildPrompt({ title, titleTokens, photoRatio, modes });
      const schema = buildSchema(modes);
      const keys   = getKeys();
      const models = getModels();

      let best = null; // usable partial answer (e.g. photo focus only)
      const startedAt = Date.now();

      outer:
      for (const model of models) {
        for (const key of keys) {
          if (!pairAvailable(key, model)) continue;
          if (Date.now() - startedAt > totalBudget) break outer;
          try {
            // up to 2 tries per model: the 2nd try tells the model what went wrong
            let p = null;
            for (let attempt = 0; attempt < 2 && !isComplete(p, modes); attempt++) {
              if (attempt > 0 && Date.now() - startedAt > totalBudget) break;
              const retryNote =
                `\n\nYour previous answer was rejected. Check: all numbers must be whole numbers; ` +
                `each line holds 1 to ${LINE_MAX_WORDS} words; the yellow part has at most ${HEAD_MAX_LINES} lines and the white part at most ${SUB_MAX_LINES}; ` +
                `the yellow lines must hold at least 3 words and the white lines at least 2 words (or the white list must be empty); ` +
                `ALL line word counts must add up to exactly ${titleTokens.length}.`;
              const pr = attempt === 0 ? prompt : prompt + retryNote;
              const text = await callGemini(key, model, pr, imgBuf, schema, opts.timeoutMs);
              p = sanitize(text, titleTokens, modes);
            }

            if (isComplete(p, modes)) {
              plan = p;
              console.log(`[Director] ✅ ${model}: head=${p.headLines ? p.headLines.length : 0} lines, sub=${p.subLines ? p.subLines.length : 0} lines, focus=${p.focus ? "ai" : "centre"}`);
              cacheSet(cacheKey, plan);
              break outer;
            }

            if (p && !best) best = p;
            console.warn(`[Director] ${model}: ${p ? "answer failed the word-for-word check" : "unusable answer"} — trying next`);
          } catch (e) {
            if (e.rateLimited) {
              // Short per-minute limit → wait what Google says; otherwise assume daily quota
              const wait = e.retryMs && e.retryMs <= 10 * 60 * 1000 ? e.retryMs + 1000 : 30 * 60 * 1000;
              cooldownUntil.set(`${key}|${model}`, Date.now() + wait);
              console.warn(`[Director] Rate limit on ${model} — paused ${Math.round(wait / 1000)}s`);
            } else if (e.status === 500 || e.status === 502 || e.status === 503 || e.status === 504) {
              // Google is overloaded (not a key problem): pause this model briefly, try the next
              cooldownUntil.set(`${key}|${model}`, Date.now() + 20 * 1000);
              console.warn(`[Director] ${model} overloaded (${e.status}) — trying next model`);
              continue outer;
            } else if (e.status === 404 || e.status === 400) {
              // Model not available / request shape not supported → skip this model for a while
              deadModels.set(model, Date.now() + 10 * 60 * 1000);
              console.warn(`[Director] ${model} unavailable: ${e.message}`);
              continue outer;
            } else {
              // timeout / network / server error: try the NEXT model (not the local logic yet)
              console.warn(`[Director] ${model} failed: ${e.message} — trying next model`);
              continue outer;
            }
          }
        }
      }

      if (!plan && best) plan = best; // partial; the poster fills the rest itself
    }

    if (!plan) {
      console.warn("[Director] No direction available — using the local logic");
      return shortInfo;
    }

    const result = { ...(shortInfo || {}) };
    if (plan.focus) result.focus = plan.focus;

    if (plan.headLines) {
      result.rewritten = true;
      result.headLines = plan.headLines;
      result.headText  = plan.headLines.join(" ");
      result.subLines  = plan.subLines && plan.subLines.length ? plan.subLines : null;
      result.subText   = (plan.subLines || []).join(" ");
    }

    return Object.keys(result).length ? result : null;
  } catch (e) {
    console.warn("[Director] Crashed, using the local logic:", e.message);
    return null;
  }
}

module.exports = {
  getDirection,
  isEnabled,
  // exported for tests
  _internal: { sanitize, rebuildFromCounts, tokensOf, validateShortTitle, shortenTitle },
};