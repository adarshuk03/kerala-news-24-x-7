const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const path  = require("path");
const fs    = require("fs");

// ── Fonts ─────────────────────────────────────────────────────
const LATIN_FONT_FILE = path.join(__dirname, "../fonts/Poppins-Bold.ttf");
if (fs.existsSync(LATIN_FONT_FILE)) {
  GlobalFonts.registerFromPath(LATIN_FONT_FILE, "English");
} else {
  console.warn("[Fonts] Poppins-Bold.ttf not found in server/fonts");
}

// MALAYALAM font (must contain Malayalam glyphs – Poppins does NOT).
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

// Optional HEAVY font for the thick headline look of the reference poster.
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

// ═══════════════════════════════════════════════════════════════
// POSTER SIZE  (3:4)
// ═══════════════════════════════════════════════════════════════
const W = 1080;
const H = 1440;

// ═══════════════════════════════════════════════════════════════
// DESIGN CONSTANTS  (UPSIDE-DOWN layout, FULL photo visible)
//
//   whole poster   BLACK background
//   top            TITLE (white lines first, yellow lines last),
//                  auto-fitted + centered in the free area
//   middle         credit line: social icons + channel name
//   bottom         PHOTO – the WHOLE image is shown (no cropping),
//                  short black fade at its top edge
//   bottom-right   optional round photos with RED border
// ═══════════════════════════════════════════════════════════════

const BLACK  = "#000000";
const WHITE  = "#ffffff";
const YELLOW = "#ffcb05";
const RED    = "#d4101a";

// Photo area (bottom). Height follows the photo's own shape, within these limits.
const PHOTO_MIN_FRAC  = 0.36;    // smallest photo area (fraction of H)
const PHOTO_MAX_FRAC  = 0.56;    // biggest photo area (fraction of H)
const COLLAGE_FRAC    = 0.50;    // photo area height in collage mode
const PHOTO_FADE_FRAC = 0.06;    // short black fade at the TOP edge of the photo
const PHOTO_GAP       = 4;       // collage mode only

// Round insets (bottom right, over the photo)
const CIRCLE_BORDER = 7;
const CIRCLE_1_R    = 0.12;      // × W
const CIRCLE_2_R    = 0.085;     // × W
const CIRCLE_MARGIN = 28;

// Credit line (icons + name) sits in a band between title and photo
const CREDIT_BAND = 84;
const CREDIT_ICON = 40;
const CREDIT_SIZE = 34;

// Title block (top)
const TEXT_TOP_PAD    = Math.round(H * 0.035);
const TEXT_GAP        = 10;      // space between title and credit band
const TEXT_MAX_W      = Math.round(W * 0.94);
const TEXT_MAX        = 84;      // biggest base font size tried
const TEXT_MIN        = 40;      // smallest base font size
const LINE_MAX        = 104;     // no single line is bigger than this
const LINE_GROW       = 1.22;    // a line may grow to base * this to fill the width
const TEXT_LH         = 1.2;
const TEXT_MAX_LINES  = 9;
const WHITE_FRACTION  = 0.45;    // first 45% of the lines are white, rest yellow

const BRAND_NAME = process.env.BRAND_NAME || "KERALA NEWS 24 X 7";

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

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

// ═══════════════════════════════════════════════════════════════
// TEXT CLEANING  –  TITLE ONLY
//
//   newsItem.title          the headline
//   newsItem.titleLines     force the line breaks (array of strings)
//   newsItem.titleWhiteLines  how many lines are white (rest yellow)
//   newsItem.uppercase      upper-case everything (English posts)
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
      .map((x) => c(typeof x === "string" ? x : x && x.text))
      .filter(Boolean);
    if (l.length) lines = l;
  }

  const text = lines ? lines.join(" ") : c(newsItem.title);
  if (!text) return null;
  return { text, lines };
}

// ═══════════════════════════════════════════════════════════════
// LINE WRAPPING + PER-LINE FITTING
// ═══════════════════════════════════════════════════════════════

function wrapTokens(ctx, words, maxW) {
  const space = ctx.measureText(" ").width;
  const lines = [];
  let cur = [];
  let curW = 0;
  for (const w of words) {
    const ww = ctx.measureText(w.t).width;
    const add = cur.length ? space + ww : ww;
    if (cur.length && curW + add > maxW) {
      lines.push({ words: cur, width: curW });
      cur = [{ ...w, w: ww }];
      curW = ww;
    } else {
      cur.push({ ...w, w: ww });
      curW += add;
    }
  }
  if (cur.length) lines.push({ words: cur, width: curW });
  return lines;
}

// Same number of lines as greedy wrapping, but with even line lengths
function balancedWrap(ctx, words, maxW) {
  const first = wrapTokens(ctx, words, maxW);
  const n = first.length;
  if (n < 2) return first;

  let lo = maxW * 0.45, hi = maxW;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (wrapTokens(ctx, words, mid).length <= n) hi = mid; else lo = mid;
  }
  return wrapTokens(ctx, words, hi);
}

// One title at one base size → lines, each with its OWN size
function layoutTitle(ctx, title, base, forced) {
  const out = [];
  let ok = true;

  let texts;
  if (forced && title.lines) {
    texts = title.lines;
  } else {
    ctx.font = `${base}px ${HEAD_FONT}`;
    const toks = wordsOf(title.text).map((t) => ({ t }));
    texts = balancedWrap(ctx, toks, TEXT_MAX_W).map((l) => l.words.map((w) => w.t).join(" "));
  }

  for (const t of texts) {
    ctx.font = `100px ${HEAD_FONT}`;
    const w100    = Math.max(1, ctx.measureText(t).width);
    const fitSize = Math.floor((100 * TEXT_MAX_W) / w100);
    const size    = Math.min(Math.round(base * LINE_GROW), fitSize, LINE_MAX);
    if (size < TEXT_MIN * 0.9) ok = false;
    out.push({ t, size, lh: Math.round(size * TEXT_LH) });
  }

  const total = out.reduce((s, l) => s + l.lh, 0);
  return { lines: out, ok, total };
}

// Biggest base size where the title fits the free area
function fitTitle(ctx, title, availH) {
  for (let S = TEXT_MAX; S >= TEXT_MIN; S -= 2) {
    for (const forced of [true, false]) {
      if (forced && !title.lines) continue;
      const r = layoutTitle(ctx, title, S, forced);
      if (r.ok && r.lines.length <= TEXT_MAX_LINES && r.total <= availH) return r;
    }
  }
  // very long title: shrink every line until the block fits the area
  const r = layoutTitle(ctx, title, TEXT_MIN, false);
  if (r.total > availH && r.total > 0) {
    const k = availH / r.total;
    r.lines = r.lines.map((l) => ({
      t: l.t,
      size: Math.max(20, Math.floor(l.size * k)),
      lh: Math.floor(l.lh * k),
    }));
    r.total = r.lines.reduce((s, l) => s + l.lh, 0);
  }
  return r;
}

// ═══════════════════════════════════════════════════════════════
// TEXT DRAWING  –  first lines white, last lines yellow
// ═══════════════════════════════════════════════════════════════

function drawTitle(ctx, lines, top, whiteCount) {
  ctx.save();
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin     = "round";
  ctx.miterLimit   = 2;

  let y = top;
  lines.forEach((ln, i) => {
    const color = i < whiteCount ? WHITE : YELLOW;

    ctx.font = `${ln.size}px ${HEAD_FONT}`;
    const base  = y + ln.lh / 2 + ln.size * 0.33;
    const thick = hasHeavy ? 0 : ln.size * 0.025;

    ctx.shadowColor   = "rgba(0,0,0,0.55)";
    ctx.shadowBlur    = 8;
    ctx.shadowOffsetY = 2;

    if (thick > 0.01) {
      ctx.lineWidth   = thick;
      ctx.strokeStyle = color;
      ctx.strokeText(ln.t, W / 2, base);
    }
    ctx.fillStyle = color;
    ctx.fillText(ln.t, W / 2, base);

    y += ln.lh;
  });

  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// PHOTO  –  bottom of the poster, WHOLE image visible (contain-fit)
//   newsItem.image    : main photo (url / path / buffer)
//   newsItem.images   : [main, circle1, circle2]  → the 2nd and 3rd go into the
//                       round red-bordered insets (bottom right)
//   newsItem.circles  : [circle1, circle2]  explicit round photos
//   newsItem.collage = true → images are drawn as a collage (cropped cells)
//   newsItem.showPhoto = false → no photo
// ═══════════════════════════════════════════════════════════════

// cover-crop (used for collage cells and circles)
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

  // gaps (if any) get a dark, dimmed copy of the same photo – no ugly empty bars
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

// imgs already loaded; photoY = top edge, photoH = height (ends at poster bottom)
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

  // short fade from BLACK at the top edge of the photo (keeps faces visible)
  const fadeLen = Math.round(H * PHOTO_FADE_FRAC);
  const fade = ctx.createLinearGradient(0, photoY, 0, photoY + fadeLen);
  fade.addColorStop(0.00, "rgba(0,0,0,1)");
  fade.addColorStop(0.40, "rgba(0,0,0,0.65)");
  fade.addColorStop(1.00, "rgba(0,0,0,0)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, photoY - 1, W, fadeLen + 1);
}

// ═══════════════════════════════════════════════════════════════
// ROUND INSETS  –  red border circles, bottom right over the photo
// ═══════════════════════════════════════════════════════════════

async function drawCircles(ctx, sources) {
  const imgs = await loadAll(sources.slice(0, 2));
  const r1 = Math.round(W * CIRCLE_1_R);
  const r2 = Math.round(W * CIRCLE_2_R);

  const c1 = { cx: W - r1 - CIRCLE_MARGIN, cy: H - r1 - CIRCLE_MARGIN, r: r1 };
  const c2 = {
    cx: W - r2 - CIRCLE_MARGIN - 10,
    cy: c1.cy - r1 - r2 - 18,
    r:  r2,
  };
  const specs = [c1, c2];

  imgs.forEach((img, i) => {
    const { cx, cy, r } = specs[i];

    // dark backing so the ring looks clean on any photo
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r + CIRCLE_BORDER, 0, Math.PI * 2);
    ctx.fillStyle = "#000000";
    ctx.fill();
    ctx.restore();

    // photo inside the circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    drawCover(ctx, img, cx - r, cy - r, r * 2, r * 2, 0.25);
    ctx.restore();

    // red ring
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r + CIRCLE_BORDER / 2 - 1, 0, Math.PI * 2);
    ctx.lineWidth   = CIRCLE_BORDER;
    ctx.strokeStyle = RED;
    ctx.stroke();
    ctx.restore();
  });
}

// ═══════════════════════════════════════════════════════════════
// CREDIT LINE  –  [f] [youtube] [instagram] [whatsapp]  name
//   newsItem.credit / brandName : text (default BRAND_NAME)
//   newsItem.showCredit = false : hide the line
// ═══════════════════════════════════════════════════════════════

function drawSocialIcon(ctx, kind, x, cy, s) {
  const y = cy - s / 2;
  ctx.save();
  ctx.strokeStyle = WHITE;
  ctx.fillStyle   = WHITE;
  ctx.lineWidth   = 2.5;
  ctx.lineJoin    = "round";

  rrect(ctx, x, y, s, s, s * 0.28);
  ctx.stroke();

  if (kind === "f") {
    ctx.font = `${Math.round(s * 0.82)}px English`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("f", x + s / 2, y + s * 0.84);
  } else if (kind === "yt") {
    rrect(ctx, x + s * 0.2, y + s * 0.3, s * 0.6, s * 0.4, s * 0.1);
    ctx.fill();
    ctx.fillStyle = BLACK;
    ctx.beginPath();
    ctx.moveTo(x + s * 0.44, y + s * 0.39);
    ctx.lineTo(x + s * 0.44, y + s * 0.61);
    ctx.lineTo(x + s * 0.64, y + s * 0.5);
    ctx.closePath();
    ctx.fill();
  } else if (kind === "ig") {
    ctx.beginPath();
    ctx.arc(x + s / 2, cy, s * 0.22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + s * 0.76, y + s * 0.24, s * 0.05, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === "wa") {
    ctx.beginPath();
    ctx.arc(x + s / 2, cy - s * 0.02, s * 0.25, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + s * 0.27, y + s * 0.78);
    ctx.lineTo(x + s * 0.33, y + s * 0.6);
    ctx.lineTo(x + s * 0.42, y + s * 0.72);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawCredit(ctx, newsItem, cy) {
  if (newsItem.showCredit === false) return;

  const name  = String(newsItem.credit || newsItem.brandName || BRAND_NAME || "").trim();
  const s     = CREDIT_ICON;
  const gap   = 9;
  const kinds = ["f", "yt", "ig", "wa"];

  ctx.save();
  ctx.font = `${CREDIT_SIZE}px English, Malayalam`;
  const tw     = name ? ctx.measureText(name).width : 0;
  const iconsW = kinds.length * s + (kinds.length - 1) * gap;
  const total  = iconsW + (name ? 16 + tw : 0);
  let x = Math.round((W - total) / 2);

  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur  = 6;

  kinds.forEach((k) => {
    drawSocialIcon(ctx, k, x, cy, s);
    x += s + gap;
  });

  if (name) {
    x += 16 - gap;
    ctx.textAlign    = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle    = WHITE;
    ctx.fillText(name, x, cy + CREDIT_SIZE * 0.34);
  }
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// MAIN POSTER DRAW
//
//   newsItem options:
//     title             the headline (first lines white, last lines yellow)
//     titleLines        force the title line breaks
//     titleWhiteLines   how many lines are white (default ~45% of the lines)
//     uppercase  true   upper-case all text
//     showPhoto  false  no photo
//     image / images    main photo; extra images become the round insets
//     circles           [img1, img2] explicit round insets
//     collage    true   draw `images` as a collage instead of insets
//     credit / brandName  text next to the social icons
//     showCredit false  hide the credit line
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
  let mainSources, circleSources;
  if (collage) {
    mainSources   = all;
    circleSources = (newsItem.circles || []).filter(Boolean);
  } else {
    mainSources   = all.slice(0, 1);
    circleSources = (newsItem.circles && newsItem.circles.length
      ? newsItem.circles
      : all.slice(1)).filter(Boolean);
  }

  // ── 3. Load the main photo(s) and decide the photo area ─────
  let mainImgs = [];
  if (newsItem.showPhoto !== false && mainSources.length) {
    mainImgs = await loadAll(mainSources.slice(0, 3));
  }
  const hasPhoto = mainImgs.length > 0;

  let photoH = 0;
  if (hasPhoto) {
    if (collage && mainImgs.length > 1) {
      photoH = Math.round(H * COLLAGE_FRAC);
    } else {
      // area height follows the photo's own shape so the whole photo fits
      const natural = Math.round(W * (mainImgs[0].height / mainImgs[0].width));
      photoH = Math.max(
        Math.round(H * PHOTO_MIN_FRAC),
        Math.min(Math.round(H * PHOTO_MAX_FRAC), natural)
      );
    }
  }
  const photoY = H - photoH;

  // ── 4. Photo + round insets ─────────────────────────────────
  if (hasPhoto) {
    drawPhoto(ctx, mainImgs, photoY, photoH, collage);
    if (circleSources.length) await drawCircles(ctx, circleSources);
  }

  // ── 5. Credit line (band right above the photo) ─────────────
  const creditBottom = hasPhoto ? photoY : H - Math.round(H * 0.03);
  const creditCY     = creditBottom - Math.round(CREDIT_BAND / 2);
  drawCredit(ctx, newsItem, creditCY);

  // ── 6. Title (top) – fitted and centered in the free area ───
  const title = buildTitle(newsItem);
  if (title) {
    const areaTop    = TEXT_TOP_PAD;
    const areaBottom = creditBottom - CREDIT_BAND - TEXT_GAP;
    const availH     = Math.max(100, areaBottom - areaTop);
    const fit        = fitTitle(ctx, title, availH);

    const textTop = areaTop + Math.max(0, Math.round((availH - fit.total) / 2));

    const n = fit.lines.length;
    const whiteCount = Number.isInteger(newsItem.titleWhiteLines)
      ? Math.max(0, Math.min(newsItem.titleWhiteLines, n))
      : n <= 1 ? n : Math.max(1, Math.round(n * WHITE_FRACTION));

    drawTitle(ctx, fit.lines, textTop, whiteCount);
  }

  // ── 7. Reset ────────────────────────────────────────────────
  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";

  const buffer = await canvasToBuffer(canvas, "image/png");
  return { type: "image", buffer, liveAdVideoUrl: null, adH: 0 };
}

module.exports = { createNewsPoster, toNodeBuffer };
