const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const path = require("path");
const fs   = require("fs");

// ── Fonts ─────────────────────────────────────────────────────
const LATIN_FONT_FILE = path.join(__dirname, "../fonts/Poppins-Bold.ttf");
if (fs.existsSync(LATIN_FONT_FILE)) {
  GlobalFonts.registerFromPath(LATIN_FONT_FILE, "English");
} else {
  console.warn("[Fonts] Poppins-Bold.ttf not found in server/fonts");
}

// Malayalam font (Poppins has NO Malayalam glyphs). First one found is used.
const MALAYALAM_CANDIDATES = [
  "NotoSansMalayalam-Bold.ttf",
  "NotoSansMalayalam-Bold.otf",
  "AnekMalayalam-Bold.ttf",
  "AnekMalayalam_SemiCondensed-Bold.ttf",
  "Manjari-Bold.ttf",
  "NotoSansMalayalam-Black.ttf",
  "Meera-Regular.ttf",
  "Rachana-Regular.ttf",
].map((f) => path.join(__dirname, "../fonts", f));

let hasMalayalam = false;
for (const p of MALAYALAM_CANDIDATES) {
  try {
    if (fs.existsSync(p)) {
      GlobalFonts.registerFromPath(p, "Malayalam");
      hasMalayalam = true;
      console.log("[Fonts] Malayalam font:", path.basename(p));
      break;
    }
  } catch (e) {
    console.warn("[Fonts] could not load", p, e.message);
  }
}
if (!hasMalayalam) {
  console.error("❌ no Malayalam font found in server/fonts – Malayalam text will not render correctly");
  if (fs.existsSync(LATIN_FONT_FILE)) GlobalFonts.registerFromPath(LATIN_FONT_FILE, "Malayalam");
}

// Optional HEAVY font for the title (thick look)
const HEAVY_CANDIDATES = [
  "AnekMalayalam_SemiCondensed-ExtraBold.ttf",
  "AnekMalayalam-ExtraBold.ttf",
  "AnekMalayalam_Condensed-ExtraBold.ttf",
  "Manjari-Bold.ttf",
  "NotoSansMalayalam-Black.ttf",
].map((f) => path.join(__dirname, "../fonts", f));

let hasHeavy = false;
for (const p of HEAVY_CANDIDATES) {
  try {
    if (fs.existsSync(p)) {
      GlobalFonts.registerFromPath(p, "MalayalamHeavy");
      hasHeavy = true;
      console.log("[Fonts] heavy headline font:", path.basename(p));
      break;
    }
  } catch (e) {
    console.warn("[Fonts] could not load", p, e.message);
  }
}

const HEAD_FONT = hasHeavy ? "MalayalamHeavy, Malayalam, English" : "Malayalam, English";
const SUM_FONT  = hasHeavy ? "MalayalamHeavy, Malayalam, English" : "Malayalam, English";
const EN_FONT   = "English, Malayalam";

// Poster size (4:5 like the reference)
const W = 1080;
const H = 1350;

// ═══════════════════════════════════════════════════════════════
// LAYOUT (copied from the reference poster)
//
//   top      black background
//   title    YELLOW lines, centred – EVERY LINE HAS ITS OWN FONT SIZE
//            (each line is stretched to its own width, so short lines
//             become big and long lines become smaller)
//            LAST lines = second colour (white), smaller
//   credit   facebook + instagram icons + channel name
//   photo    full width, fades from black at the top
//   circle   round zoom-in of the photo (bottom right, white border)
//   mark     faint channel name watermark at the bottom
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// DEFAULT SETTINGS  –  everything the right-side edit panel can change.
// Pass any key as  newsItem.settings = { ... }
// ═══════════════════════════════════════════════════════════════
const DEFAULTS = {
  channelName: process.env.BRAND_NAME || "Kerala News 24x7",
  creditText:  "",            // text next to the icons (empty → channelName)
  showIcons:   true,          // facebook + instagram icons
  watermark:   true,          // faint channel name on the photo

  // colours
  bg:      "#000000",
  yellow:  "#f7c600",
  white:   "#ffffff",

  // title sizing
  titleTopFrac:  0.085,       // distance of the title from the top (fraction of H)
  titleCap:      124,         // biggest allowed font size (px)
  titleMinSize:  40,
  titleLH:       1.18,
  // width each line is stretched to (fraction of W), repeated for more lines.
  // different numbers = different font sizes per line.
  titleWidths:   [0.60, 0.84, 0.70, 0.82, 0.65],
  titleMaxLines: 6,

  // second part of the title (other colour, smaller)
  part2Color:    "#ffffff",
  part2Lines:    2,           // how many LAST lines use the second colour
  part2Cap:      70,          // biggest font size for those lines
  part2Widths:   [0.94, 0.94],

  // photo + circle
  maxFlowFrac:   0.62,        // text block may never go lower than this (fraction of H)
  photoFocusY:   0.2,
  insetEnabled:  true,
  insetCx:       0.82,        // circle centre x (fraction of W)
  insetCy:       0.835,       // circle centre y (fraction of H)
  insetRadius:   0.157,       // circle radius (fraction of W)
  insetZoom:     2.2,         // how much the circle zooms in
  insetFocusX:   0.5,         // which part of the photo is zoomed (0–1)
  insetFocusY:   0.45,
};

const MAX_W        = Math.round(W * 0.94);
const SIDE_PAD     = Math.round((W - MAX_W) / 2);
const PHOTO_GAP    = 4;
const CREDIT_H     = 46;
const ELLIPSIS     = "...";

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
function toNodeBuffer(data) {
  if (Buffer.isBuffer(data))       return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data))    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError(`toNodeBuffer: unsupported type ${Object.prototype.toString.call(data)}`);
}

async function canvasToBuffer(canvas, mime = "image/png") {
  const result = canvas.toBuffer(mime);
  return Buffer.isBuffer(result) ? result : toNodeBuffer(await result);
}

function mergeSettings(newsItem) {
  const s = { ...DEFAULTS, ...(newsItem.settings || {}) };
  if (newsItem.channelName) s.channelName = newsItem.channelName;
  if (newsItem.brandName)   s.channelName = newsItem.brandName;
  if (newsItem.creditText)  s.creditText  = newsItem.creditText;
  if (Array.isArray(newsItem.titleWidths) && newsItem.titleWidths.length) s.titleWidths = newsItem.titleWidths;
  if (Number.isInteger(newsItem.part2Lines) && newsItem.part2Lines >= 0) s.part2Lines = newsItem.part2Lines;
  if (newsItem.part2Color) s.part2Color = newsItem.part2Color;
  if (Array.isArray(newsItem.part2Widths) && newsItem.part2Widths.length) s.part2Widths = newsItem.part2Widths;
  return s;
}

// ═══════════════════════════════════════════════════════════════
// TEXT  –  only a TITLE, in two colour parts
//
//   newsItem.titleLines = [                       ← best: you choose the lines
//       "ഏഷ്യൻ കപ്പിൽ",
//       "ഇന്ത്യൻ ക്യാപ്റ്റന് നേരെ",
//       { text: "അപമാനിക്കുന്നതും", size: 96 },     ← optional own font size
//       { text: "പലസ്തീൻ താരം", color: "#ffffff" }, ← optional own colour
//   ]
//   newsItem.title = "..."          → wrapped into lines automatically
//   newsItem.title = "part one | part two" → part one yellow, part two white
//   (no "|" → the LAST 2 lines get the second colour, see part2Lines)
//   newsItem.uppercase = true       → upper-case (English posts)
// ═══════════════════════════════════════════════════════════════
function cleanText(s, upper) {
  const t = String(s ?? "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return upper ? t.toUpperCase() : t;
}

const wordsOf = (s) => String(s).split(" ").filter(Boolean);

function limitWords(text, max) {
  const t = String(text || "").trim();
  if (!t || !max) return t;
  const words = wordsOf(t);
  if (words.length <= max) return t;
  return words.slice(0, max).join(" ").replace(/[\s,;:.\-–—]+$/u, "") + ELLIPSIS;
}

// array of strings / {text,size,color}  →  [{text,size,color}]
function itemsOf(v, c) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const l of v) {
    if (typeof l === "string") {
      const t = c(l);
      if (t) out.push({ text: t });
    } else if (l && l.text) {
      const t = c(l.text);
      if (t) out.push({ text: t, size: l.size, color: l.color });
    }
  }
  return out.length ? out : null;
}

const joinItems = (v) => (Array.isArray(v)
  ? v.map((l) => (typeof l === "string" ? l : l && l.text)).filter(Boolean).join(" ")
  : String(v ?? ""));

// ═══════════════════════════════════════════════════════════════
// WRAPPING + FITTING
// ═══════════════════════════════════════════════════════════════
function measure(ctx, font, size, text) {
  ctx.font = `${size}px ${font}`;
  return ctx.measureText(text).width;
}

function wrapTokens(ctx, words, maxW) {
  const space = ctx.measureText(" ").width;
  const lines = [];
  let cur = [], curW = 0;
  for (const w of words) {
    const ww  = ctx.measureText(w).width;
    const add = cur.length ? space + ww : ww;
    if (cur.length && curW + add > maxW) {
      lines.push(cur.join(" "));
      cur = [w]; curW = ww;
    } else {
      cur.push(w); curW += add;
    }
  }
  if (cur.length) lines.push(cur.join(" "));
  return lines;
}

// wraps one text into at most maxLines lines (shrinks the test size if needed)
function autoWrap(ctx, text, font, size, maxW, maxLines) {
  const words = wordsOf(text);
  for (let s = size; s >= 30; s -= 4) {
    ctx.font = `${s}px ${font}`;
    let lines = wrapTokens(ctx, words, maxW);
    if (lines.length <= maxLines) {
      // even out the line lengths
      if (lines.length > 1) {
        let lo = maxW * 0.4, hi = maxW;
        for (let i = 0; i < 14; i++) {
          const mid = (lo + hi) / 2;
          if (wrapTokens(ctx, words, mid).length <= lines.length) hi = mid; else lo = mid;
        }
        lines = wrapTokens(ctx, words, hi);
      }
      return lines;
    }
  }
  return wrapTokens(ctx, words, maxW);
}

// Every line gets its OWN font size: the line is stretched to targetW,
// short lines hit the cap, long lines get smaller.
function sizeLine(ctx, font, item, targetW, cap, minSize) {
  const w100 = measure(ctx, font, 100, item.text) || 1;
  let size;
  if (Number.isFinite(item.size) && item.size > 0) size = item.size;
  else size = Math.min(cap, (100 * targetW) / w100);
  size = Math.min(size, (100 * MAX_W) / w100);       // never wider than the poster
  size = Math.max(size, Math.min(minSize, (100 * MAX_W) / w100));
  return { t: item.text, size, w: (w100 * size) / 100, color: item.color || null };
}

// → [{ text, size?, color?, part: 1 | 2 }]   part 1 = yellow, part 2 = white
function splitParts(items, S) {
  const n  = items.length;
  const k2 = n > 1 ? Math.min(S.part2Lines, n - 1) : 0;
  return items.map((it, i) => ({ ...it, part: i >= n - k2 ? 2 : 1 }));
}

function buildTitle(ctx, newsItem, S, c) {
  const wrap = (text, cap, maxLines) =>
    autoWrap(ctx, text, HEAD_FONT, cap, MAX_W, maxLines).map((text2) => ({ text: text2 }));

  // 1. lines given by hand
  const manual = itemsOf(newsItem.titleLines, c);
  if (manual) return splitParts(manual, S);

  // 2. text  –  only the TITLE is used (summary / subtitle / caption are ignored)
  //    "part one | part two" → two colours; no "|" → last lines get the 2nd colour
  const parts = String(newsItem.title || "").split("|").map(c).filter(Boolean);
  let one, two;
  if (parts.length >= 2) { one = parts.slice(0, -1).join(" "); two = parts[parts.length - 1]; }
  else                   { one = parts[0] || ""; two = ""; }
  if (!one) { one = two; two = ""; }
  if (!one) return [];

  if (two) {
    return [
      ...wrap(one, S.titleCap, Math.max(1, S.titleMaxLines - 2)).map((l) => ({ ...l, part: 1 })),
      ...wrap(two, S.part2Cap, 3).map((l) => ({ ...l, part: 2 })),
    ];
  }
  return splitParts(wrap(one, S.titleCap, S.titleMaxLines), S);
}

// ═══════════════════════════════════════════════════════════════
// TEXT DRAWING
// ═══════════════════════════════════════════════════════════════
function strokeFill(ctx, text, x, y, fill, strokeColor, strokeW) {
  ctx.save();
  ctx.lineJoin   = "round";
  ctx.miterLimit = 2;
  if (strokeW > 0.01) {
    ctx.lineWidth   = strokeW;
    ctx.strokeStyle = strokeColor;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// every line: own size, own height, centred
function drawLines(ctx, lines, k, top, font, defColor, lhMul, thickMul) {
  ctx.save();
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";
  let y = top;
  for (const ln of lines) {
    const size = ln.size * k;
    const lh   = Math.round(size * lhMul);
    const color = ln.color || defColor;
    ctx.font = `${size}px ${font}`;
    const thick = hasHeavy ? 0 : size * thickMul;
    strokeFill(ctx, ln.t, W / 2, y + lh / 2 + size * 0.33, color, color, thick);
    y += lh;
  }
  ctx.restore();
  return y;
}

const linesHeight = (lines, k, lhMul) =>
  lines.reduce((a, l) => a + Math.round(l.size * k * lhMul), 0);

// ═══════════════════════════════════════════════════════════════
// PHOTO  (newsItem.image / newsItem.images up to 3 → collage)
// ═══════════════════════════════════════════════════════════════
function drawCover(ctx, img, x, y, w, h, focusY) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width  * scale;
  const dh = img.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y - Math.max(0, dh - h) * focusY;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

async function loadAll(sources) {
  const out = [];
  for (const s of sources) {
    try { out.push(await loadImage(s)); }
    catch (e) { console.warn("[Poster] photo failed:", e.message); }
  }
  return out;
}

function drawPhotoImgs(ctx, imgs, top, photoH, S) {
  const g  = PHOTO_GAP;
  const hw = Math.floor((W - g) / 2);
  const hh = Math.floor((photoH - g) / 2);
  const fy = S.photoFocusY;

  if (imgs.length === 1) {
    drawCover(ctx, imgs[0], 0, top, W, photoH, fy);
  } else if (imgs.length === 2) {
    drawCover(ctx, imgs[0], 0,      top, hw,         photoH, fy);
    drawCover(ctx, imgs[1], hw + g, top, W - hw - g, photoH, fy);
  } else {
    drawCover(ctx, imgs[0], 0,      top,          hw,         photoH, fy);
    drawCover(ctx, imgs[1], hw + g, top,          W - hw - g, hh,     fy);
    drawCover(ctx, imgs[2], hw + g, top + hh + g, W - hw - g, photoH - hh - g, fy);
  }

  // fade from black at the top of the photo
  const fadeLen = Math.min(230, Math.round(photoH * 0.4));
  const fade = ctx.createLinearGradient(0, top, 0, top + fadeLen);
  fade.addColorStop(0.00, "rgba(0,0,0,1)");
  fade.addColorStop(0.35, "rgba(0,0,0,0.78)");
  fade.addColorStop(0.70, "rgba(0,0,0,0.32)");
  fade.addColorStop(1.00, "rgba(0,0,0,0)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, top, W, fadeLen + 1);
}

// ═══════════════════════════════════════════════════════════════
// ROUND ZOOM CIRCLE  (bottom right, white border)
//   newsItem.insetImage : own image for the circle
//   otherwise the first photo is zoomed in (insetZoom / insetFocusX / Y)
//   newsItem.showInset = false → no circle
// ═══════════════════════════════════════════════════════════════
async function drawInset(ctx, newsItem, mainImg, S) {
  if (!S.insetEnabled || newsItem.showInset === false) return;

  let img = mainImg;
  let ownImage = false;
  if (newsItem.insetImage) {
    try { img = await loadImage(newsItem.insetImage); ownImage = true; }
    catch (e) { console.warn("[Poster] inset image failed:", e.message); }
  }
  if (!img) return;

  const r  = Math.round(W * S.insetRadius);
  const cx = Math.round(W * S.insetCx);
  const cy = Math.round(H * S.insetCy);

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur  = 18;
  ctx.fillStyle   = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  const box   = r * 2;
  const cover = Math.max(box / img.width, box / img.height);
  const zoom  = ownImage ? 1 : Math.max(1, S.insetZoom);
  const scale = cover * zoom;
  const fx    = ownImage ? 0.5 : S.insetFocusX;
  const fy    = ownImage ? 0.5 : S.insetFocusY;
  const dw = img.width  * scale;
  const dh = img.height * scale;
  const dx = cx - fx * dw;
  const dy = cy - fy * dh;
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// CREDIT LINE  –  [f] [instagram]  Kerala News 24x7
// ═══════════════════════════════════════════════════════════════
function drawCredit(ctx, S, top) {
  const text = String(S.creditText || S.channelName || "").trim();
  const cy   = top + CREDIT_H / 2;
  const r    = 15;
  const size = 32;

  ctx.save();
  ctx.font = `${size}px ${EN_FONT}`;
  const tw   = text ? ctx.measureText(text).width : 0;
  const icon = S.showIcons ? r * 4 + 12 + 12 : 0;      // two icons + gaps
  const total = icon + tw;
  let x = (W - total) / 2;

  if (S.showIcons) {
    // facebook
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.arc(x + r, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = S.bg;
    ctx.font = `${Math.round(r * 1.7)}px ${EN_FONT}`;
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillText("f", x + r + 1, cy + r * 0.62);

    // instagram
    const ix = x + r * 2 + 8 + r;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.arc(ix, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = S.bg;
    ctx.lineWidth = 2.4;
    const s = r * 1.1;
    const rr = 5;
    ctx.beginPath();
    ctx.moveTo(ix - s / 2 + rr, cy - s / 2);
    ctx.arcTo(ix + s / 2, cy - s / 2, ix + s / 2, cy + s / 2, rr);
    ctx.arcTo(ix + s / 2, cy + s / 2, ix - s / 2, cy + s / 2, rr);
    ctx.arcTo(ix - s / 2, cy + s / 2, ix - s / 2, cy - s / 2, rr);
    ctx.arcTo(ix - s / 2, cy - s / 2, ix + s / 2, cy - s / 2, rr);
    ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(ix, cy, s * 0.22, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = S.bg;
    ctx.beginPath(); ctx.arc(ix + s * 0.3, cy - s * 0.3, 1.6, 0, Math.PI * 2); ctx.fill();

    x += r * 4 + 8 + 12;
  }

  if (text) {
    ctx.font = `${size}px ${EN_FONT}`;
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x, cy + size * 0.34);
  }
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// WATERMARK  (faint channel name on the photo)
// ═══════════════════════════════════════════════════════════════
function drawWatermark(ctx, S) {
  const text = String(S.channelName || "").trim();
  if (!S.watermark || !text) return;
  ctx.save();
  ctx.globalAlpha  = 0.5;
  ctx.font         = `${38}px ${EN_FONT}`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle    = "#d9d9d9";
  ctx.shadowColor  = "rgba(0,0,0,0.5)";
  ctx.shadowBlur   = 4;
  ctx.fillText(text, Math.round(W * 0.38), H - 30);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// MAIN POSTER DRAW
//
//   newsItem options:
//     titleLines      [ "line", { text, size, color }, ... ]  one entry per line
//     title           plain text → wrapped automatically
//                     "part one | part two" → part one yellow, part two white
//     part2Lines      how many LAST lines use the second colour (default 2)
//     part2Color      second colour (default white)
//     titleWidths     [0.6, 0.84, ...]  width each yellow line is stretched to
//                     (this is what makes the lines big / small)
//     part2Widths     same for the second-colour lines
//     uppercase  true          upper-case all text
//     image / images           photo(s): url / path / buffer (max 3)
//     showPhoto  false         no photo
//     insetImage               own image for the round circle
//     showInset  false         no round circle
//     channelName / creditText channel name + credit text
//     settings   { ... }       any key from DEFAULTS
// ═══════════════════════════════════════════════════════════════
async function createNewsPoster(newsItem = {}) {
  const S      = mergeSettings(newsItem);
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");
  const up     = newsItem.uppercase === true;
  const c      = (s) => cleanText(s, up);

  // 1. black background
  ctx.fillStyle = S.bg;
  ctx.fillRect(0, 0, W, H);

  // 2. title lines – every line gets its OWN font size and its part colour
  const items   = buildTitle(ctx, newsItem, S, c);
  const widths1 = S.titleWidths && S.titleWidths.length ? S.titleWidths : [0.88];
  const widths2 = S.part2Widths && S.part2Widths.length ? S.part2Widths : [0.94];
  let n1 = 0, n2 = 0;

  const lines = items.map((it) => {
    const p2  = it.part === 2;
    const arr = p2 ? widths2 : widths1;
    const idx = p2 ? n2++ : n1++;
    const l = sizeLine(
      ctx, HEAD_FONT, it,
      Math.round(W * arr[idx % arr.length]),
      p2 ? S.part2Cap : S.titleCap,
      p2 ? 30 : S.titleMinSize
    );
    l.color = it.color || (p2 ? S.part2Color : S.yellow);
    return l;
  });

  // 3. flow: title → credit.  Shrink a little if the text gets too tall,
  //    so the photo always keeps room.
  const titleTop = Math.round(H * S.titleTopFrac);
  const maxFlow  = Math.round(H * S.maxFlowFrac);
  let k = 1, creditTop = 0, flowBottom = 0;

  for (; k >= 0.5; k -= 0.03) {
    creditTop  = titleTop + linesHeight(lines, k, S.titleLH) + Math.round(18 * k);
    flowBottom = creditTop + CREDIT_H;
    if (flowBottom <= maxFlow) break;
  }

  // 4. photo under the text, fading from black
  const sources = [];
  if (Array.isArray(newsItem.images)) sources.push(...newsItem.images.filter(Boolean));
  else if (newsItem.image) sources.push(newsItem.image);

  let mainImg = null;
  if (newsItem.showPhoto !== false && sources.length) {
    const imgs = await loadAll(sources.slice(0, 3));
    if (imgs.length) {
      mainImg = imgs[0];
      drawPhotoImgs(ctx, imgs, flowBottom, H - flowBottom, S);
    }
  }

  // 5. title + credit line
  drawLines(ctx, lines, k, titleTop, HEAD_FONT, S.yellow, S.titleLH, 0.03);
  drawCredit(ctx, S, creditTop);

  // 6. round zoom circle + watermark
  if (mainImg || newsItem.insetImage) await drawInset(ctx, newsItem, mainImg, S);
  drawWatermark(ctx, S);

  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";

  const buffer = await canvasToBuffer(canvas, "image/png");
  return { type: "image", buffer, liveAdVideoUrl: null, adH: 0 };
}

module.exports = { createNewsPoster, toNodeBuffer, DEFAULTS };