const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const path  = require("path");
const fs    = require("fs");

// ── Font ──────────────────────────────────────────────────────
// ONLY ONE font is used everywhere (title, footer):
//   server/fonts/AnekMalayalam_SemiCondensed-Bold.ttf
const FONT_FILE = path.join(__dirname, "../fonts/AnekMalayalam_SemiCondensed-Bold.ttf");

if (fs.existsSync(FONT_FILE)) {
  GlobalFonts.registerFromPath(FONT_FILE, "Malayalam");
  console.log("[Fonts] using", path.basename(FONT_FILE));
} else {
  console.error("❌ AnekMalayalam_SemiCondensed-Bold.ttf not found in server/fonts");
}

const HEAD_FONT = "Malayalam";
const FOOT_FONT = "Malayalam";

// Poster size.
//   Width is fixed. Height is BASE_H by default, but with ONE photo the
//   poster height adapts to the photo so the WHOLE photo is visible
//   (clamped between H_MIN and H_MAX).
const W      = 1080;
const BASE_H = 1620;
const H_MIN  = 1080;   // 1:1
const H_MAX  = 1920;   // 9:16

// ═══════════════════════════════════════════════════════════════
// DESIGN CONSTANTS
//
//   top        TITLE  – centred, bold, ALTERNATING font sizes:
//                       line 1 BIG, line 2 small, line 3 BIG, line 4 small ...
//                       light-yellow lines, LAST line white
//   middle     PHOTO  – full width, shown COMPLETELY (no zoom / no crop),
//                       short black gradient at the top
//                       (several images → collage)
//   footer     brand name on the left + dashed line to the right
//   background plain black
// ═══════════════════════════════════════════════════════════════

const BG     = "#000000";   // background
const YELLOW = "#fff59d";   // light yellow
const WHITE  = "#ffffff";   // white

// Title (at the top)
const TITLE_PAD_TOP     = 30;
const TITLE_PAD_BOTTOM  = 22;
const TITLE_MAX_W       = Math.round(W * 0.96);      // wider text area
const TITLE_MAX         = 132;                       // BIG line max size (was 96)
const TITLE_MIN         = 60;                        // BIG line min size (was 44)
const TITLE_SMALL_RATIO = 0.74;                      // small line = 74% of the big line (was 0.68)
const TITLE_LH          = 1.18;                      // slightly tighter line spacing
const TITLE_MAX_LINES   = 5;
const TITLE_MAX_H       = Math.round(BASE_H * 0.44); // taller title block allowed (was 0.34)

// Photo
const PHOTO_MIN_H        = Math.round(BASE_H * 0.40); // photo area is never smaller than this
const PHOTO_OVERLAP      = 40;                        // (cover mode) photo starts this far behind the title
const PHOTO_FADE_FRAC    = 0.30;                      // (cover mode) top fade = 30% of photo height
const PHOTO_FADE_MAX     = 340;                       // (cover mode) fade never longer than this (px)
const PHOTO_FADE_CONTAIN = 70;                        // (fit mode)   short fade so the photo stays visible
const PHOTO_GAP          = 4;                         // black gap between collage images
const PHOTO_FOCUS_Y      = 0.2;                       // (cover mode) 0 = keep top, 1 = keep bottom

// Footer
const FOOTER_H      = 100;                           // space reserved at the bottom
const FOOTER_PAD_X  = 28;
const BRAND_NAME    = process.env.BRAND_NAME || "KERALA NEWS 24 X 7";

// Text thickness (a single semi-condensed bold font, so thicken it slightly)
const TITLE_STROKE = 0.03;

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

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ═══════════════════════════════════════════════════════════════
// TEXT CLEANING  –  only the TITLE is shown (no summary)
//
//   newsItem.title                  → top title
//        (fallbacks: summary, subtitle, description, caption)
//   newsItem.title = "a | b"        → parts are joined into one title
//   newsItem.titleLines             forces the line breaks
//   newsItem.uppercase = true       upper-case everything (English posts)
// ═══════════════════════════════════════════════════════════════

function cleanText(s, upper) {
  const t = String(s ?? "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return upper ? t.toUpperCase() : t;
}

const wordsOf = (s) => String(s).split(" ").filter(Boolean);

function joinLines(v) {
  return Array.isArray(v)
    ? v.map((l) => (typeof l === "string" ? l : l && l.text)).filter(Boolean).join(" ")
    : String(v ?? "");
}

function linesOf(v, c) {
  if (!Array.isArray(v)) return null;
  const out = v.map((l) => c(typeof l === "string" ? l : l && l.text)).filter(Boolean);
  return out.length ? out : null;
}

// → { text, lines|null } | null
function buildTitle(newsItem) {
  const up = newsItem.uppercase === true;
  const c  = (s) => cleanText(s, up);

  let raw   = joinLines(newsItem.titleLines) || String(newsItem.title || "");
  let lines = linesOf(newsItem.titleLines, c);

  if (!c(raw)) {
    raw =
      joinLines(newsItem.summaryLines) ||
      String(newsItem.summary || "") ||
      joinLines(newsItem.subTitleLines) ||
      String(newsItem.subtitle || "") ||
      String(newsItem.description || "") ||
      String(newsItem.caption || "");
    lines = linesOf(newsItem.summaryLines || newsItem.subTitleLines, c);
  }

  if (raw.includes("|")) {
    raw = raw.split("|").map(c).filter(Boolean).join(" ");
    lines = null;
  }

  const text = c(raw);
  if (!text) return null;
  return { text, lines: lines && lines.length ? lines : null };
}

// ═══════════════════════════════════════════════════════════════
// LINE WRAPPING + FITTING  (alternating BIG / small lines)
// ═══════════════════════════════════════════════════════════════

const sizeForLine = (i, big, small) => (i % 2 === 0 ? big : small);

function measureAt(ctx, text, size, font) {
  ctx.font = `${size}px ${font}`;
  return ctx.measureText(text).width;
}

// Greedy wrap where line 0 uses the big font, line 1 the small font, ...
function wrapAlt(ctx, words, maxW, big, small, font) {
  const lines = [];
  let cur = [];
  for (const w of words) {
    const idx  = lines.length;
    const size = sizeForLine(idx, big, small);
    const test = cur.concat(w).join(" ");
    if (cur.length && measureAt(ctx, test, size, font) > maxW) {
      const t = cur.join(" ");
      lines.push({ t, w: measureAt(ctx, t, size, font), size });
      cur = [w];
    } else {
      cur.push(w);
    }
  }
  if (cur.length) {
    const idx  = lines.length;
    const size = sizeForLine(idx, big, small);
    const t = cur.join(" ");
    lines.push({ t, w: measureAt(ctx, t, size, font), size });
  }
  return lines;
}

// Same number of lines as greedy wrapping, but with more even line lengths
function balancedWrapAlt(ctx, words, maxW, big, small, font) {
  const first = wrapAlt(ctx, words, maxW, big, small, font);
  const n = first.length;
  if (n < 2) return first;

  let lo = maxW * 0.45, hi = maxW;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (wrapAlt(ctx, words, mid, big, small, font).length <= n) hi = mid; else lo = mid;
  }
  return wrapAlt(ctx, words, hi, big, small, font);
}

function layoutAt(ctx, block, big, small, font, maxW, maxLines) {
  let lines;
  if (block.lines) {
    lines = block.lines.map((t, i) => {
      const size = sizeForLine(i, big, small);
      return { t, w: measureAt(ctx, t, size, font), size };
    });
  } else {
    lines = balancedWrapAlt(ctx, wordsOf(block.text), maxW, big, small, font);
  }
  const ok = lines.length <= maxLines && lines.every((l) => l.w <= maxW + 1);
  return { lines, ok };
}

const totalHeight = (lines) => lines.reduce((s, l) => s + Math.round(l.size * TITLE_LH), 0);

function fitTitle(ctx, block, font, o) {
  for (let big = o.max; big >= o.min; big -= 2) {
    const small = Math.round(big * TITLE_SMALL_RATIO);
    const r = layoutAt(ctx, block, big, small, font, o.maxW, o.maxLines);
    const total = totalHeight(r.lines);
    if (r.ok && total <= o.maxH) return { lines: r.lines, total, big, small };
  }
  return null;
}

function fitWithFallback(ctx, block, font, o) {
  let res = fitTitle(ctx, block, font, o);
  if (!res && block.lines) res = fitTitle(ctx, { text: block.text, lines: null }, font, o);
  if (res) return res;

  // nothing fits (a very long text): smallest size, any number of lines
  const small = Math.round(o.min * TITLE_SMALL_RATIO);
  const r = layoutAt(ctx, { text: block.text, lines: null }, o.min, small, font, o.maxW, 99);
  return { lines: r.lines, total: totalHeight(r.lines), big: o.min, small };
}

// Gold title look (like the "സ്വർണം!" reference)
const GOLD_STOPS = [
  [0.00, "#fff27a"],   // bright yellow top
  [0.35, "#ffd51a"],   // golden yellow
  [0.70, "#f7a800"],   // orange-gold
  [1.00, "#ffc61a"],   // warm yellow at the bottom
];
const OUTLINE_COLOR = "#0b1a3a";   // dark navy outline
const OUTLINE_W     = 0.13;        // outline thickness (× font size)
const SHINE_ALPHA   = 0.38;        // glossy highlight strength

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

// TITLE: gold letters with a thick navy outline and a glossy shine.
// Big / small lines alternate. The last line(s) can be white (titleBlackLines).
function drawTitle(ctx, L, top, whiteCount) {
  ctx.save();
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";

  const n = L.lines.length;
  let y = top;

  L.lines.forEach((ln, i) => {
    const lh    = Math.round(ln.size * TITLE_LH);
    const base  = y + lh / 2 + ln.size * 0.33;
    const white = i >= n - whiteCount;
    ctx.font = `${ln.size}px ${HEAD_FONT}`;

    // 1) thick navy outline with a soft shadow, drawn on the poster
    ctx.save();
    ctx.lineJoin    = "round";
    ctx.miterLimit  = 2;
    ctx.lineWidth   = ln.size * OUTLINE_W;
    ctx.strokeStyle = OUTLINE_COLOR;
    ctx.shadowColor   = "rgba(0,0,0,0.65)";
    ctx.shadowBlur    = 12;
    ctx.shadowOffsetY = 5;
    ctx.strokeText(ln.t, W / 2, base);
    ctx.restore();

    // 2) the fill (gold or white) is drawn on a small scratch canvas,
    //    so the shine only touches the letters
    const pad  = Math.ceil(ln.size * 0.35);
    const tmpH = lh + pad * 2;
    const tmp  = createCanvas(W, tmpH);
    const t    = tmp.getContext("2d");
    const tb   = pad + (base - y);           // baseline inside the scratch canvas
    const gTop = tb - ln.size * 0.95;
    const gBot = tb + ln.size * 0.25;

    t.textAlign    = "center";
    t.textBaseline = "alphabetic";
    t.font         = `${ln.size}px ${HEAD_FONT}`;
    t.lineJoin     = "round";

    let fill;
    if (white) {
      fill = WHITE;
    } else {
      fill = t.createLinearGradient(0, gTop, 0, gBot);
      GOLD_STOPS.forEach(([p, c]) => fill.addColorStop(p, c));
    }

    t.fillStyle   = fill;
    t.strokeStyle = fill;
    t.lineWidth   = ln.size * 0.02;          // slightly bolder letters
    t.strokeText(ln.t, W / 2, tb);
    t.fillText(ln.t, W / 2, tb);

    if (!white) {
      t.globalCompositeOperation = "source-atop";   // only on the letters

      // glossy light on the upper half
      const gloss = t.createLinearGradient(0, gTop, 0, tb - ln.size * 0.25);
      gloss.addColorStop(0, `rgba(255,255,255,${SHINE_ALPHA})`);
      gloss.addColorStop(1, "rgba(255,255,255,0)");
      t.fillStyle = gloss;
      t.fillRect(0, gTop, W, tb - ln.size * 0.25 - gTop);

      // diagonal sheen streak across the line
      const x0 = W / 2 - ln.w / 2;
      const sheen = t.createLinearGradient(x0, gTop, x0 + ln.w, gBot);
      sheen.addColorStop(0.00, "rgba(255,255,255,0)");
      sheen.addColorStop(0.42, "rgba(255,255,255,0)");
      sheen.addColorStop(0.50, `rgba(255,255,255,${SHINE_ALPHA})`);
      sheen.addColorStop(0.58, "rgba(255,255,255,0)");
      sheen.addColorStop(1.00, "rgba(255,255,255,0)");
      t.fillStyle = sheen;
      t.fillRect(0, gTop, W, gBot - gTop);
    }

    ctx.drawImage(tmp, 0, y - pad);
    y += lh;
  });

  ctx.restore();
}
// ═══════════════════════════════════════════════════════════════
// PHOTO  –  full width under the title
//   newsItem.image    : one photo (url / path / buffer)
//   newsItem.images   : up to 3 photos → collage
//                       2 = side by side, 3 = 1 big left + 2 stacked right
//   newsItem.showPhoto = false     → no photo
//   newsItem.photoFit  = "cover"   → old behaviour: zoom to fill (crops the photo)
//                        "contain" → (default) whole photo visible, nothing cropped
// ═══════════════════════════════════════════════════════════════

// zoom to fill the box (crops)
function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width  * scale;
  const dh = img.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y - Math.max(0, dh - h) * PHOTO_FOCUS_Y;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
  return { x, y, w, h };
}

// whole photo visible, centred inside the box (no crop)
function drawContain(ctx, img, x, y, w, h) {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width  * scale;
  const dh = img.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
  return { x: dx, y: dy, w: dw, h: dh };
}

async function loadAll(sources) {
  const out = [];
  for (const s of sources) {
    try {
      out.push(await loadImage(s));
    } catch (e) {
      console.warn("[Poster] photo failed:", e.message);
    }
  }
  return out;
}

function drawPhoto(ctx, imgs, top, photoH, fit) {
  if (!imgs.length) return false;

  const draw = fit === "cover" ? drawCover : drawContain;
  const g  = PHOTO_GAP;
  const hw = Math.floor((W - g) / 2);
  const hh = Math.floor((photoH - g) / 2);

  let firstRect;
  if (imgs.length === 1) {
    firstRect = draw(ctx, imgs[0], 0, top, W, photoH);
  } else if (imgs.length === 2) {
    firstRect = draw(ctx, imgs[0], 0,       top, hw,          photoH);
    draw(ctx, imgs[1], hw + g,  top, W - hw - g,  photoH);
  } else {
    firstRect = draw(ctx, imgs[0], 0,       top,          hw,          photoH);
    draw(ctx, imgs[1], hw + g,  top,          W - hw - g,  hh);
    draw(ctx, imgs[2], hw + g,  top + hh + g, W - hw - g,  photoH - hh - g);
  }

  // gradient at the TOP of the photo: solid black → transparent
  let fadeTop, fadeLen;
  if (fit === "cover") {
    fadeTop = top;
    fadeLen = Math.min(PHOTO_FADE_MAX, Math.max(120, Math.round(photoH * PHOTO_FADE_FRAC)));
  } else {
    // fit mode: start at the real top edge of a single photo; short fade
    fadeTop = imgs.length === 1 ? firstRect.y : top;
    fadeLen = PHOTO_FADE_CONTAIN;
  }

  const fade = ctx.createLinearGradient(0, fadeTop, 0, fadeTop + fadeLen);
  fade.addColorStop(0.00, "rgba(0,0,0,1)");
  fade.addColorStop(0.20, "rgba(0,0,0,0.85)");
  fade.addColorStop(0.45, "rgba(0,0,0,0.50)");
  fade.addColorStop(0.70, "rgba(0,0,0,0.18)");
  fade.addColorStop(1.00, "rgba(0,0,0,0)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, fadeTop, W, fadeLen);

  return true;
}

// ═══════════════════════════════════════════════════════════════
// FOOTER  –  brand logo / name on the left + dashed line to the right
//   newsItem.logo       : logo image (url / path / buffer)  – used if given
//   newsItem.brandName  : text brand (default: env BRAND_NAME)
// ═══════════════════════════════════════════════════════════════

async function drawFooter(ctx, newsItem, H) {
  const cy = H - Math.round(FOOTER_H * 0.56);
  let   endX = FOOTER_PAD_X;

  let logo = null;
  if (newsItem.logo) {
    try { logo = await loadImage(newsItem.logo); }
    catch (e) { console.warn("[Poster] logo failed:", e.message); }
  }

  if (logo) {
    const lh = 56;
    const lw = Math.min(320, Math.round((logo.width / logo.height) * lh));
    const h2 = Math.round((logo.height / logo.width) * lw);
    ctx.drawImage(logo, FOOTER_PAD_X, cy - h2 / 2, lw, h2);
    endX = FOOTER_PAD_X + lw;
  } else {
    const name  = cleanText(newsItem.brandName || BRAND_NAME, true);
    if (name) {
      let first, rest, joiner = " ";
      const parts = name.split(" ");
      const m = parts.length === 1 && name.match(/^(\D+)(\d+)$/);
      if (m) {                       // "NEWSLINE24" → NEWSLINE (yellow) + 24 (white)
        first = m[1]; rest = m[2]; joiner = "";
      } else {
        first = parts[0];
        rest  = parts.slice(1).join(" ");
      }
      const size  = 46;

      ctx.save();
      ctx.textAlign    = "left";
      ctx.textBaseline = "alphabetic";
      ctx.font         = `${size}px ${FOOT_FONT}`;
      const base = cy + size * 0.33;

      let x = FOOTER_PAD_X;
      strokeFill(ctx, first, x, base, YELLOW, YELLOW, size * 0.03);
      x += ctx.measureText(first).width;
      if (rest) {
        if (joiner) x += ctx.measureText(joiner).width;
        strokeFill(ctx, rest, x, base, WHITE, WHITE, size * 0.03);
        x += ctx.measureText(rest).width;
      }
      ctx.restore();
      endX = x;
    }
  }

  // dashed line
  ctx.save();
  ctx.strokeStyle = "#bdbdbd";
  ctx.lineWidth   = 2;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.moveTo(endX + 18, cy);
  ctx.lineTo(W - FOOTER_PAD_X, cy);
  ctx.stroke();
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// MAIN POSTER DRAW
//
//   newsItem options:
//     title                 top title (alternating big / small lines,
//                           light-yellow lines, last line white)
//     titleLines            force the title line breaks
//     titleBlackLines       how many LAST title lines are white (default 1)
//     uppercase   true      upper-case all text
//     showPhoto   false     no photo
//     photoFit              "contain" (default, whole photo visible) | "cover" (zoom/crop)
//     image / images        photo(s): url / path / buffer (images = collage, max 3)
//     logo / brandName      footer brand
// ═══════════════════════════════════════════════════════════════

async function createNewsPoster(newsItem) {

  // ── 1. Measure the title (top) on a small scratch canvas ────
  const mctx = createCanvas(W, 10).getContext("2d");
  const head = buildTitle(newsItem);

  let titleL      = null;
  let titleBottom = 0;
  if (head) {
    titleL = fitWithFallback(mctx, head, HEAD_FONT, {
      max: TITLE_MAX, min: TITLE_MIN,
      maxW: TITLE_MAX_W, maxLines: TITLE_MAX_LINES,
      maxH: Math.min(TITLE_MAX_H, BASE_H - FOOTER_H - PHOTO_MIN_H - TITLE_PAD_TOP - TITLE_PAD_BOTTOM),
    });
    titleBottom = TITLE_PAD_TOP + titleL.total + TITLE_PAD_BOTTOM;
  }

  // ── 2. Load the photo(s) ────────────────────────────────────
  const sources = [];
  if (Array.isArray(newsItem.images)) sources.push(...newsItem.images.filter(Boolean));
  else if (newsItem.image) sources.push(newsItem.image);
  if (!sources.length && newsItem.image) sources.push(newsItem.image);

  const imgs = newsItem.showPhoto !== false && sources.length
    ? await loadAll(sources.slice(0, 3))
    : [];

  const fit = newsItem.photoFit === "cover" ? "cover" : "contain";

  // ── 3. Poster height: with ONE photo it follows the photo ───
  let H = BASE_H;
  if (imgs.length === 1 && fit === "contain") {
    const natural = Math.round(W * imgs[0].height / imgs[0].width);
    H = clamp(titleBottom + natural + FOOTER_H, H_MIN, H_MAX);
  }

  const contentBottom = H - FOOTER_H;
  const photoTop = fit === "cover"
    ? Math.max(0, titleBottom - (titleL ? PHOTO_OVERLAP : 0))
    : titleBottom;
  const photoH = Math.max(100, contentBottom - photoTop);

  // ── 4. Draw ─────────────────────────────────────────────────
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  if (imgs.length) drawPhoto(ctx, imgs, photoTop, photoH, fit);

  if (titleL) {
    const whiteCount = titleL.lines.length > 1
      ? Math.min(Number.isInteger(newsItem.titleBlackLines) ? newsItem.titleBlackLines : 1, titleL.lines.length - 1)
      : 0;
    drawTitle(ctx, titleL, TITLE_PAD_TOP, whiteCount);
  }

  await drawFooter(ctx, newsItem, H);

  // ── 5. Reset ────────────────────────────────────────────────
  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";

  const buffer = await canvasToBuffer(canvas, "image/png");
  // no ad strip any more: liveAdVideoUrl is always null, adH is 0
  return { type: "image", buffer, liveAdVideoUrl: null, adH: 0 };
}

module.exports = { createNewsPoster, toNodeBuffer };
