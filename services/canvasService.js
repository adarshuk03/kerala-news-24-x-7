const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const path  = require("path");
const fs    = require("fs");

// ── Font: ONLY AnekMalayalam_SemiCondensed-Bold.ttf ───────────
// Put the file in  server/fonts/AnekMalayalam_SemiCondensed-Bold.ttf
const FONT_FILE = path.join(__dirname, "../fonts/AnekMalayalam_SemiCondensed-Bold.ttf");
if (fs.existsSync(FONT_FILE)) {
  GlobalFonts.registerFromPath(FONT_FILE, "Malayalam");
  console.log("[Fonts] using", path.basename(FONT_FILE));
} else {
  console.error("❌ AnekMalayalam_SemiCondensed-Bold.ttf not found in server/fonts");
}
const FONT = "Malayalam, sans-serif";

// ═══════════════════════════════════════════════════════════════
// POSTER SIZE  (same shape as the reference)
// ═══════════════════════════════════════════════════════════════
const W = 1080;
const H = 1470;

// ═══════════════════════════════════════════════════════════════
// DESIGN CONSTANTS
//
//   whole poster   BLACK
//   top            TITLE – yellow lines, last line WHITE,
//                  sizes alternate  BIG / small / BIG / small …
//                  every line fills (almost) the full width
//   bottom         PHOTO – full width, whole image visible,
//                  black gradient fade at its TOP edge (under the title)
// ═══════════════════════════════════════════════════════════════

const BLACK  = "#000000";
const WHITE  = "#ffffff";
const YELLOW = "#ffd21f";

// Photo (bottom). Height follows the photo's own shape, within these limits.
const PHOTO_MIN_FRAC  = 0.50;     // × H
const PHOTO_MAX_FRAC  = 0.72;     // × H
const COLLAGE_FRAC    = 0.62;     // photo height in collage mode
const PHOTO_FADE_FRAC = 0.10;     // black fade length at the top edge of the photo
const PHOTO_GAP       = 4;        // collage mode only

// Title block (top)
const TITLE_TOP_PAD  = Math.round(H * 0.016);
const TITLE_OVERLAP  = Math.round(H * 0.02);   // title may touch the start of the fade
const TEXT_MAX_W     = Math.round(W * 0.92);
const TEXT_MIN       = 34;
const SIZE_MAX       = 132;       // biggest "BIG" line size tried
const SMALL          = 0.63;      // small lines = BIG × 0.63
const LINE_GROW      = 1.12;      // a line may grow this much to fill the width
const TEXT_LH        = 1.18;
const TEXT_MAX_LINES = 8;

const BRAND_NAME = process.env.BRAND_NAME || "KERALA NEWS 24X7";

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

// ═══════════════════════════════════════════════════════════════
// TITLE TEXT
//
//   newsItem.title        the headline (auto line breaks)
//   newsItem.titleLines   force the line breaks. Each entry is a string or
//                         { text, color: "yellow"|"white"|"#hex", size }
//   newsItem.whiteLines   how many LAST lines are white (default 1)
//   newsItem.uppercase    upper-case everything (English posts)
// ═══════════════════════════════════════════════════════════════

function cleanText(s, upper) {
  const t = String(s ?? "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return upper ? t.toUpperCase() : t;
}

const wordsOf = (s) => String(s).split(" ").filter(Boolean);

function buildTitle(newsItem) {
  const up = newsItem.uppercase === true;
  const c  = (s) => cleanText(s, up);

  let lines = null;
  if (Array.isArray(newsItem.titleLines)) {
    const l = newsItem.titleLines
      .map((x) => {
        if (typeof x === "string") return { t: c(x) };
        if (x && typeof x === "object") return { t: c(x.text), color: x.color, size: x.size };
        return { t: "" };
      })
      .filter((x) => x.t);
    if (l.length) lines = l;
  }

  const text = lines ? lines.map((l) => l.t).join(" ") : c(newsItem.title);
  if (!text) return null;
  return { text, lines };
}

// ═══════════════════════════════════════════════════════════════
// TITLE LAYOUT
//
//   Lines alternate BIG (size S) / small (size S × 0.63).
//   Words are filled into each line at THAT line's size, so a small line
//   holds more words than a big one – exactly like the reference.
//   Then every line may grow a little to fill the full width.
//   S = the biggest size where the whole block fits the free area.
// ═══════════════════════════════════════════════════════════════

function resolveColor(c, fallback) {
  if (!c) return fallback;
  const k = String(c).toLowerCase();
  if (k === "white")  return WHITE;
  if (k === "yellow") return YELLOW;
  return c;
}

function wrapAlternating(ctx, words, S) {
  const lines = [];
  let k = 0;
  let i = 0;
  while (k < words.length) {
    const size = Math.round(i % 2 === 0 ? S : S * SMALL);
    ctx.font = `${size}px ${FONT}`;
    const space = ctx.measureText(" ").width;

    const cur = [words[k]];
    let w = ctx.measureText(words[k]).width;
    k++;
    while (k < words.length) {
      const ww = ctx.measureText(words[k]).width;
      if (w + space + ww > TEXT_MAX_W) break;
      cur.push(words[k]);
      w += space + ww;
      k++;
    }
    lines.push({ t: cur.join(" "), size });
    i++;
    if (lines.length > TEXT_MAX_LINES) break;
  }
  return lines;
}

// grow each line (≤ LINE_GROW) to fill the width; shrink if a single word is too wide
function fitLines(ctx, lines) {
  return lines.map((l) => {
    ctx.font = `100px ${FONT}`;
    const w100 = Math.max(1, ctx.measureText(l.t).width);
    const fit  = Math.floor((100 * TEXT_MAX_W) / w100);
    const size = Math.max(20, Math.round(Math.min(l.size * LINE_GROW, fit)));
    return { ...l, size, lh: Math.round(size * TEXT_LH) };
  });
}

function layoutTitle(ctx, title, availH, whiteLines) {
  const forced = title.lines ? title.lines.slice(0, TEXT_MAX_LINES) : null;
  const words  = wordsOf(title.text);

  const colorize = (lines) => {
    const n = lines.length;
    const wCount = Number.isInteger(whiteLines)
      ? Math.max(0, Math.min(whiteLines, n))
      : (n >= 2 ? 1 : 0);
    return lines.map((l, i) => ({
      ...l,
      color: resolveColor(l.color, i >= n - wCount ? WHITE : YELLOW),
    }));
  };

  let best = null;
  for (let S = SIZE_MAX; S >= TEXT_MIN; S -= 2) {
    let raw;
    if (forced) {
      raw = forced.map((l, i) => ({
        ...l,
        size: l.size || Math.round(i % 2 === 0 ? S : S * SMALL),
      }));
    } else {
      raw = wrapAlternating(ctx, words, S);
    }
    if (raw.length > TEXT_MAX_LINES) continue;

    const lines = fitLines(ctx, colorize(raw));
    const total = lines.reduce((s, l) => s + l.lh, 0);
    best = { lines, total };
    if (total <= availH) return best;
  }

  // very long title: shrink every line until the block fits
  if (best && best.total > availH && best.total > 0) {
    const k = availH / best.total;
    best.lines = best.lines.map((l) => ({
      ...l,
      size: Math.max(20, Math.floor(l.size * k)),
      lh:   Math.floor(l.lh * k),
    }));
    best.total = best.lines.reduce((s, l) => s + l.lh, 0);
  }
  return best || { lines: [], total: 0 };
}

// ═══════════════════════════════════════════════════════════════
// TITLE DRAWING  –  heavy look from a same-colour stroke
// ═══════════════════════════════════════════════════════════════

function drawTitle(ctx, layout, top) {
  ctx.save();
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin     = "round";
  ctx.miterLimit   = 2;

  let y = top;
  layout.lines.forEach((ln) => {
    ctx.font = `${ln.size}px ${FONT}`;
    const base  = y + ln.lh / 2 + ln.size * 0.33;
    const thick = ln.size * 0.03;

    ctx.lineWidth   = thick;
    ctx.strokeStyle = ln.color;
    ctx.strokeText(ln.t, W / 2, base);

    ctx.fillStyle = ln.color;
    ctx.fillText(ln.t, W / 2, base);

    y += ln.lh;
  });

  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// PHOTO  –  bottom of the poster, WHOLE image visible (contain-fit)
//   newsItem.image    : main photo (url / path / buffer)
//   newsItem.images   : several photos → collage (cropped cells)
//   newsItem.collage = true → force collage with `images`
//   newsItem.showPhoto = false → no photo
// ═══════════════════════════════════════════════════════════════

function drawCover(ctx, img, x, y, w, h, focusY = 0.08) {
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

// contain-fit: the whole image is visible, centered, never cropped
function drawContain(ctx, img, x, y, w, h) {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width  * scale;
  const dh = img.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;

  // gaps (if any) get a dark, dimmed copy of the same photo – no empty bars
  if (dw < w - 1 || dh < h - 1) {
    drawCover(ctx, img, x, y, w, h, 0.5);
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  ctx.drawImage(img, dx, dy, dw, dh);
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

function drawPhoto(ctx, imgs, photoY, photoH, collage) {
  if (!collage || imgs.length === 1) {
    drawContain(ctx, imgs[0], 0, photoY, W, photoH);
  } else {
    const g  = PHOTO_GAP;
    const hw = Math.floor((W - g) / 2);
    const hh = Math.floor((photoH - g) / 2);
    if (imgs.length === 2) {
      drawCover(ctx, imgs[0], 0,      photoY, hw,         photoH);
      drawCover(ctx, imgs[1], hw + g, photoY, W - hw - g, photoH);
    } else {
      drawCover(ctx, imgs[0], 0,      photoY,          hw,         photoH);
      drawCover(ctx, imgs[1], hw + g, photoY,          W - hw - g, hh);
      drawCover(ctx, imgs[2], hw + g, photoY + hh + g, W - hw - g, photoH - hh - g);
    }
  }

  // black fade at the TOP edge of the photo (blends into the title area)
  const fadeLen = Math.round(H * PHOTO_FADE_FRAC);
  const fade = ctx.createLinearGradient(0, photoY, 0, photoY + fadeLen);
  fade.addColorStop(0.00, "rgba(0,0,0,1)");
  fade.addColorStop(0.35, "rgba(0,0,0,0.75)");
  fade.addColorStop(1.00, "rgba(0,0,0,0)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, photoY - 1, W, fadeLen + 1);
}

// ═══════════════════════════════════════════════════════════════
// OPTIONAL CHANNEL NAME  –  small text at the very bottom
//   (the reference has none, so it is OFF by default)
//   newsItem.showCredit = true → show it
//   newsItem.credit / brandName : text (default KERALA NEWS 24X7)
// ═══════════════════════════════════════════════════════════════

function drawCredit(ctx, newsItem) {
  if (newsItem.showCredit !== true) return;
  const name = String(newsItem.credit || newsItem.brandName || BRAND_NAME || "").trim();
  if (!name) return;

  ctx.save();
  ctx.font         = `30px ${FONT}`;
  ctx.fillStyle    = WHITE;
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor  = "rgba(0,0,0,0.7)";
  ctx.shadowBlur   = 8;
  ctx.fillText(name, W / 2, H - Math.round(H * 0.022));
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// MAIN POSTER DRAW
//
//   newsItem options:
//     title             the headline (auto line breaks, BIG / small alternating)
//     titleLines        force the title lines (strings or {text,color,size})
//     whiteLines        how many LAST lines are white (default 1, rest yellow)
//     uppercase  true   upper-case all text
//     image / images    the news photo (several → collage)
//     collage    true   draw `images` as a collage
//     showPhoto  false  no photo
//     showCredit true   small channel name at the bottom
//     brandName / credit  channel name (default KERALA NEWS 24X7)
// ═══════════════════════════════════════════════════════════════

async function createNewsPoster(newsItem) {

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  // ── 1. Black background ─────────────────────────────────────
  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, W, H);

  // ── 2. Photo sources ────────────────────────────────────────
  const all = [];
  if (Array.isArray(newsItem.images)) all.push(...newsItem.images.filter(Boolean));
  else if (newsItem.image) all.push(newsItem.image);
  if (!all.length && newsItem.image) all.push(newsItem.image);

  const collage = newsItem.collage === true;
  const mainSources = collage ? all : all.slice(0, 1);

  // ── 3. Load the photo(s) and decide the photo area ──────────
  let imgs = [];
  if (newsItem.showPhoto !== false && mainSources.length) {
    imgs = await loadAll(mainSources.slice(0, 3));
  }
  const hasPhoto = imgs.length > 0;

  let photoH = 0;
  if (hasPhoto) {
    if (collage && imgs.length > 1) {
      photoH = Math.round(H * COLLAGE_FRAC);
    } else {
      // area height follows the photo's own shape so the whole photo fits
      const natural = Math.round(W * (imgs[0].height / imgs[0].width));
      photoH = Math.max(
        Math.round(H * PHOTO_MIN_FRAC),
        Math.min(Math.round(H * PHOTO_MAX_FRAC), natural)
      );
    }
  }
  const photoY = hasPhoto ? H - photoH : H;

  // ── 4. Photo (with the black fade at its top) ───────────────
  if (hasPhoto) drawPhoto(ctx, imgs, photoY, photoH, collage);

  // ── 5. Title (top) – centered in the free black area ────────
  const title = buildTitle(newsItem);
  if (title) {
    const areaTop    = TITLE_TOP_PAD;
    const areaBottom = hasPhoto ? photoY + TITLE_OVERLAP : H - Math.round(H * 0.04);
    const availH     = Math.max(160, areaBottom - areaTop);
    const layout     = layoutTitle(ctx, title, availH, newsItem.whiteLines);
    const textTop    = areaTop + Math.max(0, Math.round((availH - layout.total) / 2));
    drawTitle(ctx, layout, textTop);
  }

  // ── 6. Optional channel name ────────────────────────────────
  drawCredit(ctx, newsItem);

  // ── 7. Reset ────────────────────────────────────────────────
  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";

  const buffer = await canvasToBuffer(canvas, "image/png");
  return { type: "image", buffer, liveAdVideoUrl: null, adH: 0 };
}

module.exports = { createNewsPoster, toNodeBuffer };
