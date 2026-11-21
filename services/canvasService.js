const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const path  = require("path");
const sharp = require("sharp");
const fs    = require("fs");
const os    = require("os");
const { fileURLToPath } = require("url");

// fluent-ffmpeg + ffmpeg-static for frame extraction
let ffmpeg;
try {
  ffmpeg = require("fluent-ffmpeg");
  const ffmpegPath  = require("ffmpeg-static");
  const ffprobePath = require("ffprobe-static").path;

  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    ffmpeg.setFfmpegPath(ffmpegPath);
  } else {
    console.error("❌ ffmpeg binary missing:", ffmpegPath);
  }

  if (ffprobePath && fs.existsSync(ffprobePath)) {
    ffmpeg.setFfprobePath(ffprobePath);
  } else {
    console.error("❌ ffprobe binary missing:", ffprobePath);
  }
} catch (err) {
  console.error("[Video] fluent-ffmpeg setup failed:", err.message);
  ffmpeg = null;
}

// ── Fonts ─────────────────────────────────────────────────────
GlobalFonts.registerFromPath(
  path.join(__dirname, "../fonts/AnekMalayalam_SemiCondensed-Bold.ttf"),
  "Malayalam"
);
GlobalFonts.registerFromPath(
  path.join(__dirname, "../fonts/AnekMalayalam_SemiCondensed-Bold.ttf"),
  "English"
);

// Optional HEAVY Malayalam font (first one found in server/fonts/ is used).
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

// Optional clean Latin UI font for the date + channel bar (Roboto / Inter look).
const UI_CANDIDATES = [
  "Roboto-Medium.ttf",
  "Roboto-Regular.ttf",
  "Inter-Medium.ttf",
  "Inter-Regular.ttf",
  "Poppins-Medium.ttf",
].map((f) => path.join(__dirname, "../fonts", f));

let hasUi = false;
for (const p of UI_CANDIDATES) {
  try {
    if (fs.existsSync(p)) {
      GlobalFonts.registerFromPath(p, "LatinUI");
      hasUi = true;
      console.log("[Fonts] UI font:", path.basename(p));
      break;
    }
  } catch (e) {
    console.warn("[Fonts] could not load", p, e.message);
  }
}

const HEAD_FONT  = hasHeavy ? "MalayalamHeavy, Malayalam, English" : "Malayalam, English";
const LATIN_FONT = hasUi ? "LatinUI, English, Malayalam" : "English, Malayalam";

// ── Asset paths ──────────────────────────────────────────────
const FALLBACK_VIDEO_PATH =
  process.env.FALLBACK_VIDEO ||
  path.join(__dirname, "../assets/ad_fallback.mp4");

// Default channel logo (square PNG). Used only when the right panel
// does not send newsItem.channelLogo. If the file is missing, a letter badge is drawn.
const LOGO_PATH =
  process.env.POSTER_LOGO ||
  path.join(__dirname, "../assets/channel-logo.png");

const W            = 1080;
const H            = 1350;          // 4:5 poster
const DEFAULT_AD_H = 180;
const MAX_AD_H     = 320;

// ═══════════════════════════════════════════════════════════════
// DESIGN CONSTANTS
// ═══════════════════════════════════════════════════════════════

const COLOR_BG       = "#ffffff";
const COLOR_HEAD     = "#e4122a";     // red headline
const COLOR_SUB      = "#111111";     // black sub-headline
const COLOR_DATE     = "#222222";
const COLOR_LOGO_BG  = "#e8202c";
const COLOR_BAR      = "#33cfff";     // cyan channel bar
const COLOR_BAR_TEXT = "#14233a";

// Photo box (rounded, inset from the sides, sits at the very top)
const PHOTO_X       = 48;
const PHOTO_Y       = 0;
const PHOTO_W       = W - PHOTO_X * 2;
const PHOTO_H       = 594;
const PHOTO_RADIUS  = 56;
const PHOTO_GAP     = 6;              // white gap between photos when 2–3 are used
const PHOTO_SPLIT   = 0.34;
const PHOTO_FOCUS_Y = 0.20;
const MAX_PHOTOS    = 3;
const PHOTO_FETCH_TIMEOUT_MS = 15000;
const PHOTO_MAX_SIDE = 2400;

// Date (top-left, over the photo)
const DATE_X    = 134;
const DATE_Y    = 80;                 // vertical centre
const DATE_FONT = 38;

// Text block (red headline + black sub-headline)
const TEXT_TOP    = 640;
const TEXT_BOTTOM = 1195;

const HEAD_TARGET_W  = Math.round(W * 0.87);
const HEAD_MAX       = 108;
const HEAD_MIN       = 40;
const HEAD_MAX_LINES = 5;
const SUB_MAX_LINES  = 3;
const SUB_RATIO      = 0.82;          // sub-headline size relative to headline
const SUB_GAP        = 6;             // extra space between red and black blocks
const HEAD_LH_TRY    = [1.16, 1.12, 1.08, 1.04, 1.0];
const HEAD_BOLD_W    = 0.030;         // red headline weight (higher = bolder)
const SUB_BOLD_W     = 0;             // black sub-headline: no extra stroke = thinner

// Logo + channel bar
const LOGO_SIZE     = 98;
const LOGO_CENTER_Y = 1256;
const BAR_X         = 165;
const BAR_W         = W - BAR_X * 2;
const BAR_Y         = 1280;
const BAR_H         = H - BAR_Y;
const BAR_RADIUS    = 20;
const BAR_FONT      = 38;

// Channel name (comes from the right panel: newsItem.channelName)
const CHANNEL_NAME_DEFAULT = "KERALA NEWS 24 X 7";

function getChannelName(newsItem) {
  const v = newsItem.channelName || newsItem.siteText;
  return typeof v === "string" && v.trim() ? v.trim() : CHANNEL_NAME_DEFAULT;
}

function computeAdHeight(adImg) {
  if (!adImg) return DEFAULT_AD_H;
  const naturalH = Math.round((adImg.height / adImg.width) * W);
  return Math.min(MAX_AD_H, Math.max(DEFAULT_AD_H, naturalH));
}

const MALAYALAM_BOLD_W = 0.012;

function fillTextBold(ctx, text, x, y, fontSize, extraWidth = 0) {
  const lineWidth = Math.max(0, fontSize * MALAYALAM_BOLD_W + extraWidth);
  ctx.save();
  if (lineWidth > 0.01) {
    ctx.lineJoin    = "round";
    ctx.miterLimit  = 2;
    ctx.lineWidth   = lineWidth;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.strokeText(text, x, y);
  }
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function toNodeBuffer(data) {
  if (Buffer.isBuffer(data))       return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data))    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError(`toNodeBuffer: unsupported type ${Object.prototype.toString.call(data)}`);
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return toNodeBuffer(await res.arrayBuffer());
}

async function fetchAsJpegBuffer(url) {
  const raw = await fetchBuffer(url);
  return toNodeBuffer(await sharp(raw).jpeg().toBuffer());
}

async function canvasToBuffer(canvas, mime = "image/png") {
  const result = canvas.toBuffer(mime);
  return Buffer.isBuffer(result) ? result : toNodeBuffer(await result);
}

// Rounded-rectangle path with per-corner radii: r = [tl, tr, br, bl]
function roundedRectPath(ctx, x, y, w, h, r) {
  const [tl, tr, br, bl] = Array.isArray(r) ? r : [r, r, r, r];
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y,     x + w, y + tr,     tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x,     y + h, x, y + h - bl,     bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x,     y,     x + tl, y,         tl);
  ctx.closePath();
}

// ═══════════════════════════════════════════════════════════════
// PHOTO LOADING  (robust: url / path / file:// / data: / Buffer / {url})
// ═══════════════════════════════════════════════════════════════

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0 Safari/537.36",
  "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
};

const isBinary = (v) =>
  Buffer.isBuffer(v) || v instanceof ArrayBuffer || ArrayBuffer.isView(v);

function resolvePhotoSource(s) {
  if (!s) return null;
  if (typeof s === "string") return s.trim() || null;
  if (isBinary(s)) return s;
  if (typeof s === "object") {
    return resolvePhotoSource(s.url || s.src || s.path || s.secure_url || s.buffer || null);
  }
  return null;
}

function describeSource(s) {
  if (isBinary(s)) return `<buffer ${s.byteLength || s.length} bytes>`;
  const t = String(s);
  return t.length > 140 ? t.slice(0, 140) + "…" : t;
}

async function loadPhotoBuffer(src) {
  if (isBinary(src)) return toNodeBuffer(src);
  if (typeof src !== "string") throw new Error("unsupported photo source");

  let s = src.trim();

  // data URI
  if (s.startsWith("data:")) {
    const comma = s.indexOf(",");
    if (comma < 0) throw new Error("bad data URI");
    const isB64 = /;base64/i.test(s.slice(0, comma));
    return isB64
      ? Buffer.from(s.slice(comma + 1), "base64")
      : Buffer.from(decodeURIComponent(s.slice(comma + 1)), "utf8");
  }

  // protocol-relative URL
  if (s.startsWith("//")) s = "https:" + s;

  // http(s) URL
  if (/^https?:\/\//i.test(s)) {
    let url = s;
    try { url = new URL(s).href; } catch { /* keep as is */ }
    const res = await fetch(url, {
      headers:  BROWSER_HEADERS,
      redirect: "follow",
      signal:   AbortSignal.timeout(PHOTO_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching photo`);
    const buf = toNodeBuffer(await res.arrayBuffer());
    if (!buf.length) throw new Error("photo response was empty");
    return buf;
  }

  // file:// URL
  if (/^file:\/\//i.test(s)) s = fileURLToPath(s);

  // local path
  const candidates = [
    s,
    path.resolve(s),
    path.join(__dirname, "..", s.replace(/^[/\\]+/, "")),
    path.join(process.cwd(), s.replace(/^[/\\]+/, "")),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return fs.readFileSync(c);
    } catch { /* try next */ }
  }
  throw new Error("photo file not found");
}

async function loadPhoto(rawSrc) {
  const src = resolvePhotoSource(rawSrc);
  if (!src) throw new Error("empty photo source");

  const raw = await loadPhotoBuffer(src);

  try {
    const jpeg = await sharp(raw, { failOn: "none" })
      .rotate()
      .flatten({ background: "#000000" })
      .resize({
        width: PHOTO_MAX_SIDE, height: PHOTO_MAX_SIDE,
        fit: "inside", withoutEnlargement: true,
      })
      .jpeg({ quality: 92 })
      .toBuffer();
    return await loadImage(jpeg);
  } catch (e) {
    console.warn("[Poster] sharp could not convert the photo, trying it as is:", e.message);
    return await loadImage(raw);
  }
}

// ═══════════════════════════════════════════════════════════════
// AI DIRECTOR (Gemini)
// ═══════════════════════════════════════════════════════════════

let _director = null;
function getDirector() {
  if (_director !== null) return _director || null;
  try {
    _director = require("./geminiArtDirector");
  } catch (e) {
    console.warn("[Poster] geminiArtDirector not found next to this file – using the local split:", e.message);
    _director = false;
  }
  return _director || null;
}

async function askDirector(newsItem) {
  if (newsItem.direction) return newsItem.direction;
  if (newsItem.aiDirector === false) return null;
  const d = getDirector();
  if (!d || !d.isEnabled()) return null;
  try {
    return await d.getDirection(newsItem, {
      layout:     true,
      focus:      getPhotoSources(newsItem).length === 1,
      photoRatio: (PHOTO_W / PHOTO_H).toFixed(2),
    });
  } catch (e) {
    console.warn("[Poster] director failed:", e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// VIDEO FRAME EXTRACTION
// ═══════════════════════════════════════════════════════════════

function extractVideoFrame(videoPath, atSecond = 1) {
  return new Promise((resolve) => {
    if (!ffmpeg) {
      console.warn("[Video] fluent-ffmpeg not available — skipping frame extract");
      return resolve(null);
    }

    if (!fs.existsSync(videoPath)) {
      console.warn("[Video] File not found:", videoPath);
      return resolve(null);
    }

    try {
      const stat = fs.statSync(videoPath);
      if (stat.size === 0) {
        console.warn("[Video] File is zero bytes:", videoPath);
        return resolve(null);
      }
    } catch (e) {
      console.warn("[Video] Could not stat file:", videoPath, e.message);
      return resolve(null);
    }

    const tmpFile = path.join(os.tmpdir(), `ad_frame_${Date.now()}.png`);
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => {
      console.error("[Video] Frame extraction timed out:", videoPath);
      fs.unlink(tmpFile, () => {});
      finish(null);
    }, 15000);

    ffmpeg(videoPath)
      .on("error", (err) => {
        clearTimeout(timer);
        console.error("[Video] Frame extraction failed:", err.message);
        fs.unlink(tmpFile, () => {});
        finish(null);
      })
      .on("end", async () => {
        clearTimeout(timer);
        try {
          if (!fs.existsSync(tmpFile)) {
            console.error("[Video] Expected frame file was never written:", tmpFile);
            return finish(null);
          }
          const raw     = fs.readFileSync(tmpFile);
          const jpegBuf = toNodeBuffer(await sharp(raw).jpeg().toBuffer());
          fs.unlink(tmpFile, () => {});
          finish(jpegBuf);
        } catch (e) {
          console.error("[Video] Sharp conversion failed:", e.message);
          fs.unlink(tmpFile, () => {});
          finish(null);
        }
      })
      .screenshots({
        timestamps: [atSecond],
        filename:   path.basename(tmpFile),
        folder:     path.dirname(tmpFile),
        size:       `${W}x?`,
      });
  });
}

// ═══════════════════════════════════════════════════════════════
// AD STRIP (unchanged)
// ═══════════════════════════════════════════════════════════════

function drawAdStrip(ctx, adImg, yOffset, adH) {

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, yOffset, W, adH);

  if (adImg) {
    const scale = Math.max(W / adImg.width, adH / adImg.height);
    const drawW = adImg.width  * scale;
    const drawH = adImg.height * scale;
    const drawX = (W - drawW) / 2;
    const drawY = yOffset + (adH - drawH) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, yOffset, W, adH);
    ctx.clip();
    ctx.drawImage(adImg, drawX, drawY, drawW, drawH);
    ctx.restore();

    const lineGrad = ctx.createLinearGradient(0, 0, W, 0);
    lineGrad.addColorStop(0,   "rgba(255,180,0,0)");
    lineGrad.addColorStop(0.2, "rgba(255,180,0,0.8)");
    lineGrad.addColorStop(0.8, "rgba(255,180,0,0.8)");
    lineGrad.addColorStop(1,   "rgba(255,180,0,0)");
    ctx.fillStyle = lineGrad;
    ctx.fillRect(0, yOffset, W, 3);

    return;
  }

  const bg = ctx.createLinearGradient(0, yOffset, 0, yOffset + adH);
  bg.addColorStop(0, "#0d1b4b");
  bg.addColorStop(1, "#091230");
  ctx.fillStyle = bg;
  ctx.fillRect(0, yOffset, W, adH);

  const lineGrad = ctx.createLinearGradient(0, 0, W, 0);
  lineGrad.addColorStop(0,   "rgba(255,180,0,0)");
  lineGrad.addColorStop(0.2, "rgba(255,180,0,1)");
  lineGrad.addColorStop(0.8, "rgba(255,180,0,1)");
  lineGrad.addColorStop(1,   "rgba(255,180,0,0)");

  ctx.fillStyle = lineGrad;
  ctx.fillRect(0, yOffset, W, 3);

  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle   = "#ffffff";
  for (let x = 40; x < W; x += 60) {
    for (let y = yOffset + 20; y < yOffset + adH - 20; y += 40) {
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  ctx.save();
  ctx.font         = "bold 52px English";
  ctx.fillStyle    = "rgba(255,200,60,0.22)";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("📢", W / 2, yOffset + adH / 2 - 8);
  ctx.restore();

  const line1    = "ADVERTISE WITH US";
  const line2    = "Send us a message";
  const LINE_GAP = 58;
  const midY     = yOffset + adH / 2;

  ctx.save();
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor  = "rgba(0,0,0,0.8)";
  ctx.shadowBlur   = 14;

  ctx.font      = "42px Malayalam, English";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  fillTextBold(ctx, line1, W / 2, midY - LINE_GAP / 2, 42);

  const goldGrad = ctx.createLinearGradient(0, midY, 0, midY + 50);
  goldGrad.addColorStop(0, "#ffe566");
  goldGrad.addColorStop(1, "#ffaa00");

  ctx.font      = "44px Malayalam, English";
  ctx.fillStyle = goldGrad;
  fillTextBold(ctx, line2, W / 2, midY + LINE_GAP / 2, 44);

  ctx.restore();

  ctx.fillStyle = lineGrad;
  ctx.fillRect(0, yOffset + adH - 3, W, 3);
}

// ═══════════════════════════════════════════════════════════════
// PHOTOS  –  rounded box at the top, light grey placeholder if missing
//   newsItem.images = [url/path/buffer, ...]  (1–3)   or  newsItem.image
//   newsItem.showPhoto = false → no photos
// ═══════════════════════════════════════════════════════════════

function getPhotoSources(newsItem) {
  if (newsItem.showPhoto === false) return [];
  let list = [];
  if (Array.isArray(newsItem.images) && newsItem.images.length) list = newsItem.images;
  else if (Array.isArray(newsItem.image))                       list = newsItem.image;
  else if (newsItem.image)                                      list = [newsItem.image];
  else if (newsItem.imageUrl)                                   list = [newsItem.imageUrl];

  return list
    .map(resolvePhotoSource)
    .filter(Boolean)
    .slice(0, MAX_PHOTOS);
}

async function drawPhotos(ctx, sources, focus) {
  const n  = sources.length;
  const pw = PHOTO_W;
  const ph = PHOTO_H;

  // column widths (gaps are painted white on top)
  let widths;
  if (n <= 1)       widths = [pw];
  else if (n === 2) { const a = Math.round(pw * PHOTO_SPLIT); widths = [a, pw - a]; }
  else {
    const a = Math.round(pw / 3);
    widths = [a, a, pw - 2 * a];
  }

  const imgs = await Promise.all(
    sources.map(async (s) => {
      try {
        return await loadPhoto(s);
      } catch (e) {
        console.error(`[Poster] photo failed (${describeSource(s)}): ${e.message}`);
        return null;
      }
    })
  );

  // draw all photos on their own layer first
  const layer = createCanvas(pw, ph);
  const lc    = layer.getContext("2d");
  lc.fillStyle = "#e9ecef";
  lc.fillRect(0, 0, pw, ph);

  let x = 0;
  imgs.forEach((img, i) => {
    const cw = widths[i];

    lc.save();
    lc.beginPath();
    lc.rect(x, 0, cw, ph);
    lc.clip();

    if (img) {
      const scale = Math.max(cw / img.width, ph / img.height);
      const dw = img.width  * scale;
      const dh = img.height * scale;
      let dx = x + (cw - dw) / 2;
      let dy = -Math.max(0, dh - ph) * PHOTO_FOCUS_Y;

      // AI photo focus (single photo only)
      if (n === 1 && focus && Number.isFinite(focus.x) && Number.isFinite(focus.y)) {
        dx = Math.min(0, Math.max(pw - dw, pw / 2 - focus.x * dw));
        dy = Math.min(0, Math.max(ph - dh, ph * 0.40 - focus.y * dh));
      }
      lc.drawImage(img, dx, dy, dw, dh);
    }
    lc.restore();

    // white divider between photos
    if (i > 0) {
      lc.fillStyle = COLOR_BG;
      lc.fillRect(x - PHOTO_GAP / 2, 0, PHOTO_GAP, ph);
    }
    x += cw;
  });

  // paste the layer through a rounded-rectangle clip
  ctx.save();
  roundedRectPath(ctx, PHOTO_X, PHOTO_Y, pw, ph, PHOTO_RADIUS);
  ctx.clip();
  ctx.drawImage(layer, PHOTO_X, PHOTO_Y);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// DATE  (top-left over the photo, dd.mm.yyyy)
// ═══════════════════════════════════════════════════════════════

function formatDate(v) {
  let d;
  if (v instanceof Date) d = v;
  else if (typeof v === "string" && v.trim()) {
    // already formatted like 18.11.2026 → keep as is
    if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(v.trim())) return v.trim().replace(/[/-]/g, ".");
    d = new Date(v);
  } else if (typeof v === "number") d = new Date(v);
  else d = new Date();

  if (isNaN(d.getTime())) d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function drawDate(ctx, newsItem) {
  if (newsItem.showDate === false) return;
  const label = formatDate(newsItem.date || newsItem.publishedAt || newsItem.createdAt);

  ctx.save();
  ctx.font         = `${DATE_FONT}px ${LATIN_FONT}`;
  ctx.fillStyle    = newsItem.dateColor || COLOR_DATE;
  ctx.textAlign    = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, DATE_X, DATE_Y);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// LOGO + CHANNEL BAR
//   newsItem.channelName  → text in the cyan bar (default "flashkeralam")
//   newsItem.channelLogo  → logo above the bar (url / path / buffer / data URI)
//   newsItem.showFooter   → false hides logo + bar
// ═══════════════════════════════════════════════════════════════

let _logoImg;   // undefined = not tried yet, null = not available
async function getLogoImage() {
  if (_logoImg !== undefined) return _logoImg;
  try {
    _logoImg = fs.existsSync(LOGO_PATH) ? await loadImage(fs.readFileSync(LOGO_PATH)) : null;
  } catch (e) {
    console.warn("[Poster] logo image failed, using letter badge:", e.message);
    _logoImg = null;
  }
  return _logoImg;
}

async function drawLogo(ctx, newsItem) {
  const size = LOGO_SIZE;
  const x = (W - size) / 2;
  const y = LOGO_CENTER_Y - size / 2;

  // 1) logo sent from the right panel (keeps PNG transparency)
  let img = null;
  const custom = resolvePhotoSource(newsItem.channelLogo || newsItem.logo);
  if (custom) {
    try {
      img = await loadImage(await loadPhotoBuffer(custom));
    } catch (e) {
      console.warn("[Poster] channel logo failed:", e.message);
    }
  }
  // 2) logo file in assets/
  if (!img) img = await getLogoImage();

  if (img) {
    const s  = Math.min(size / img.width, size / img.height);
    const dw = img.width * s, dh = img.height * s;
    ctx.save();
    roundedRectPath(ctx, x, y, size, size, size * 0.2);
    ctx.clip();
    ctx.drawImage(img, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  // 3) fallback badge: red rounded square with the channel's first letter
  const initial = (Array.from(getChannelName(newsItem))[0] || "F").toUpperCase();
  ctx.save();
  ctx.fillStyle = COLOR_LOGO_BG;
  roundedRectPath(ctx, x, y, size, size, size * 0.2);
  ctx.fill();
  ctx.fillStyle    = "#ffffff";
  ctx.font         = `bold ${Math.round(size * 0.62)}px ${LATIN_FONT}`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initial, x + size / 2, y + size / 2 + size * 0.03);
  ctx.restore();
}

function drawSiteBar(ctx, newsItem) {
  const text = getChannelName(newsItem);

  ctx.save();
  ctx.fillStyle = COLOR_BAR;
  // rounded top corners only, runs to the bottom edge of the poster
  roundedRectPath(ctx, BAR_X, BAR_Y, BAR_W, BAR_H, [BAR_RADIUS, BAR_RADIUS, 0, 0]);
  ctx.fill();

  // shrink long names so they always fit inside the bar
  let fontPx = BAR_FONT;
  ctx.font = `${fontPx}px ${LATIN_FONT}`;
  while (ctx.measureText(text).width > BAR_W - 60 && fontPx > 20) {
    fontPx -= 2;
    ctx.font = `${fontPx}px ${LATIN_FONT}`;
  }

  ctx.fillStyle    = COLOR_BAR_TEXT;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, W / 2, BAR_Y + 44);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// TEXT  –  red lines / black lines
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

function sanitizeAiLayout(layout, rawTitle, c) {
  if (!layout || !Array.isArray(layout.headLines) || !layout.headLines.length) return null;
  const head = layout.headLines.map(c).filter(Boolean);
  const sub  = (Array.isArray(layout.subLines) ? layout.subLines : []).map(c).filter(Boolean);
  if (!head.length) return null;

  const got  = wordsOf([...head, ...sub].join(" "));
  const want = wordsOf(c(rawTitle));
  if (got.length !== want.length || got.some((w, i) => w !== want[i])) return null;
  return { head, sub };
}

function localSplit(words) {
  const N = words.length;
  if (N < 4) return { head: words, sub: [] };

  const target = Math.round(N * 0.66);
  const lo = Math.max(2, Math.ceil(N * 0.5));
  const hi = Math.min(N - 1, Math.ceil(N * 0.8));

  let cut = Math.max(lo, Math.min(hi, target));
  let bestDist = Infinity;
  for (let n = lo; n <= hi; n++) {
    if (/[’”"'.!?;:,।…]$/.test(words[n - 1])) {
      const d = Math.abs(n - target);
      if (d < bestDist) { bestDist = d; cut = n; }
    }
  }
  return { head: words.slice(0, cut), sub: words.slice(cut) };
}

function buildCopy(newsItem) {
  const up = newsItem.uppercase === true;
  const c  = (s) => cleanText(s, up);

  const mk = (text, lines) => {
    const t = c(text);
    return t ? { text: t, lines: lines && lines.length ? lines : null } : null;
  };

  const rawTitle = joinLines(newsItem.titleLines) || String(newsItem.title || "");

  // 1) explicit subtitle
  const subRaw = joinLines(newsItem.subTitleLines) || String(newsItem.subtitle || "");
  if (c(subRaw)) {
    const head = mk(rawTitle, linesOf(newsItem.titleLines, c));
    if (!head) return { head: mk(subRaw, linesOf(newsItem.subTitleLines, c)), sub: null };
    return { head, sub: mk(subRaw, linesOf(newsItem.subTitleLines, c)) };
  }

  // 2) "red | black"
  if (rawTitle.includes("|")) {
    const parts = rawTitle.split("|").map(c).filter(Boolean);
    if (parts.length === 1) return { head: mk(parts[0]), sub: null };
    return {
      head: mk(parts.slice(0, -1).join(" ")),
      sub:  mk(parts[parts.length - 1]),
    };
  }

  // 2b) explicit red line breaks, no subtitle
  const fixed = linesOf(newsItem.titleLines, c);
  if (fixed) return { head: mk(fixed.join(" "), fixed), sub: null };

  // 3) lines chosen by the AI director
  const ai = sanitizeAiLayout(newsItem.aiLayout, rawTitle, c);
  if (ai) {
    return {
      head: mk(ai.head.join(" "), ai.head),
      sub:  ai.sub.length ? mk(ai.sub.join(" "), ai.sub) : null,
    };
  }

  // 4) local split
  const words = wordsOf(c(rawTitle));
  if (!words.length) return { head: null, sub: null };
  if (newsItem.autoTiers === false) return { head: mk(words.join(" ")), sub: null };

  const sp = localSplit(words);
  return {
    head: mk(sp.head.join(" ")),
    sub:  sp.sub.length ? mk(sp.sub.join(" ")) : null,
  };
}

// ═══════════════════════════════════════════════════════════════
// LINE WRAPPING + FITTING
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

function layoutBlock(ctx, block, size, maxW, maxLines) {
  ctx.font = `${size}px ${HEAD_FONT}`;
  let lines;
  if (block.lines) {
    lines = block.lines.map((t) => ({ t, w: ctx.measureText(t).width }));
  } else {
    const toks = wordsOf(block.text).map((t) => ({ t }));
    lines = balancedWrap(ctx, toks, maxW).map((l) => ({
      t: l.words.map((w) => w.t).join(" "),
      w: l.width,
    }));
  }
  const ok = lines.length <= maxLines && lines.every((l) => l.w <= maxW + 1);
  return { lines, ok };
}

// Red block uses `size`, black block uses `subSize` (a bit smaller)
function layoutPosterOnce(ctx, copy, availH) {

  const attempt = (maxHeadLines) => {
    for (let size = HEAD_MAX; size >= HEAD_MIN; size -= 2) {
      const subSize = Math.max(HEAD_MIN, Math.round(size * SUB_RATIO));

      const hb = layoutBlock(ctx, copy.head, size, HEAD_TARGET_W, maxHeadLines);
      if (!hb.ok) continue;

      let sb = null;
      if (copy.sub) {
        sb = layoutBlock(ctx, copy.sub, subSize, HEAD_TARGET_W, SUB_MAX_LINES);
        if (!sb.ok) continue;
      }

      for (const f of HEAD_LH_TRY) {
        const lh    = Math.round(size * f);
        const subLh = Math.round(subSize * f);
        const total = hb.lines.length * lh + (sb ? SUB_GAP + sb.lines.length * subLh : 0);
        if (total <= availH) {
          return {
            size, lh, subSize, subLh,
            headLines: hb.lines,
            subLines:  sb ? sb.lines : null,
            total,
          };
        }
      }
    }
    return null;
  };

  const best = attempt(4) || attempt(HEAD_MAX_LINES);
  if (best) return best;

  const subSize = HEAD_MIN;
  const hb = layoutBlock(ctx, copy.head, HEAD_MIN, HEAD_TARGET_W, 99);
  const sb = copy.sub ? layoutBlock(ctx, copy.sub, subSize, HEAD_TARGET_W, 99) : null;
  const f  = HEAD_LH_TRY[HEAD_LH_TRY.length - 1];
  const lh = Math.round(HEAD_MIN * f);
  return {
    size: HEAD_MIN, lh, subSize, subLh: lh,
    headLines: hb.lines,
    subLines:  sb ? sb.lines : null,
    total: hb.lines.length * lh + (sb ? SUB_GAP + sb.lines.length * lh : 0),
  };
}

function layoutPoster(ctx, copy, availH) {
  const hasHL = Boolean(copy.head && copy.head.lines);
  const hasSL = Boolean(copy.sub && copy.sub.lines);

  const base = layoutPosterOnce(ctx, copy, availH);
  if (!hasHL && !hasSL) return base;

  const variants = [];
  if (hasHL) variants.push({ ...copy, head: { ...copy.head, lines: null } });
  if (hasSL) variants.push({ ...copy, sub:  { ...copy.sub,  lines: null } });
  if (hasHL && hasSL) {
    variants.push({
      head: { ...copy.head, lines: null },
      sub:  { ...copy.sub,  lines: null },
    });
  }

  let best = base;
  for (const v of variants) {
    const L = layoutPosterOnce(ctx, v, availH);
    if (L.size > best.size) best = L;
  }
  return best.size >= base.size * 1.04 ? best : base;
}

// ═══════════════════════════════════════════════════════════════
// TEXT DRAWING  (flat red + flat black, like the reference)
// ═══════════════════════════════════════════════════════════════

function strokeFill(ctx, text, x, y, lineWidth) {
  ctx.save();
  if (lineWidth > 0.01) {
    ctx.lineJoin    = "round";
    ctx.miterLimit  = 2;
    ctx.lineWidth   = lineWidth;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.strokeText(text, x, y);
  }
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawCopy(ctx, L, top) {
  ctx.save();
  ctx.textAlign    = "center";
  ctx.textBaseline = "alphabetic";

  // red headline (heavier)
  ctx.font      = `${L.size}px ${HEAD_FONT}`;
  ctx.fillStyle = COLOR_HEAD;
  L.headLines.forEach((ln, i) => {
    const y = top + i * L.lh + L.lh / 2 + L.size * 0.33;
    strokeFill(ctx, ln.t, W / 2, y, L.size * HEAD_BOLD_W);
  });

  // black sub-headline (lighter)
  if (L.subLines) {
    const subTop = top + L.headLines.length * L.lh + SUB_GAP;
    ctx.font      = `${L.subSize}px ${HEAD_FONT}`;
    ctx.fillStyle = COLOR_SUB;
    L.subLines.forEach((ln, j) => {
      const y = subTop + j * L.subLh + L.subLh / 2 + L.subSize * 0.33;
      strokeFill(ctx, ln.t, W / 2, y, L.subSize * SUB_BOLD_W);
    });
  }
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════
// MAIN POSTER DRAW
// ═══════════════════════════════════════════════════════════════

async function createNewsPoster(newsItem) {

  // Normalise the photo input once, so the director and the poster see the same thing
  const photos = getPhotoSources(newsItem);
  if (photos.length) {
    newsItem = { ...newsItem, images: photos, image: photos[0] };
  } else if (newsItem.showPhoto !== false) {
    console.warn("[Poster] no photo supplied (newsItem.image / newsItem.images is empty)");
  }

  // ── AI director: red / black split, line breaks, photo focus ──
  const direction = await askDirector(newsItem);

  if (direction && direction.shortTitle) {
    console.log("[Poster] long title shortened by AI:", direction.shortTitle);
    newsItem = { ...newsItem, title: direction.shortTitle };
  }

  if (direction && direction.headLines) {
    newsItem = {
      ...newsItem,
      aiLayout: { headLines: direction.headLines, subLines: direction.subLines || [] },
    };
  }

  // ── Ad pipeline (unchanged) ─────────────────────────────────
  const hasAdUrl  = Boolean(newsItem.adBannerUrl);
  const isVideoAd = newsItem.adResourceType === "video";
  let   adImg     = null;
  let   actualAdH = DEFAULT_AD_H;
  let   liveAdVideoUrl = null;

  if (hasAdUrl && !isVideoAd) {
    try {
      console.log("[Ad] Loading image banner:", newsItem.adBannerUrl);
      const jpegBuf = await fetchAsJpegBuffer(newsItem.adBannerUrl);
      adImg         = await loadImage(jpegBuf);
      actualAdH     = computeAdHeight(adImg);
      console.log(`[Ad] Image banner loaded: ${adImg.width}x${adImg.height}px, strip: ${actualAdH}px`);
    } catch (err) {
      console.error("[Ad] Image banner load failed:", err.message);
    }
  }

  if (!adImg && hasAdUrl && isVideoAd) {
    let tmpVidPath = null;
    try {
      console.log("[Ad] Probing video banner dimensions:", newsItem.adBannerUrl);
      tmpVidPath     = path.join(os.tmpdir(), `ad_video_${Date.now()}.mp4`);
      const vidBuf   = await fetchBuffer(newsItem.adBannerUrl);
      fs.writeFileSync(tmpVidPath, vidBuf);

      const frameBuf = await extractVideoFrame(tmpVidPath, 1);
      if (frameBuf) {
        const probeImg = await loadImage(frameBuf);
        actualAdH      = computeAdHeight(probeImg);
        console.log(`[Ad] Video banner probed: ${probeImg.width}x${probeImg.height}px, strip: ${actualAdH}px`);
      } else {
        console.warn("[Ad] Video banner probe returned null — using default height");
      }
      liveAdVideoUrl = newsItem.adBannerUrl;
    } catch (err) {
      console.error("[Ad] Video banner probe failed:", err.message);
      liveAdVideoUrl = newsItem.adBannerUrl;
    } finally {
      if (tmpVidPath) {
        try { fs.unlinkSync(tmpVidPath); } catch { /* ignore */ }
      }
    }
  }

  if (!adImg && !liveAdVideoUrl) {
    console.log("[Ad] Using local video fallback (live composite):", FALLBACK_VIDEO_PATH);
    try {
      const frameBuf = await extractVideoFrame(FALLBACK_VIDEO_PATH, 1);
      if (frameBuf) {
        const probeImg = await loadImage(frameBuf);
        actualAdH      = computeAdHeight(probeImg);
        console.log(`[Ad] Local fallback probed: ${probeImg.width}x${probeImg.height}px, strip: ${actualAdH}px`);
      } else {
        console.warn("[Ad] Local fallback probe returned null — using default height");
        actualAdH = DEFAULT_AD_H;
      }
      liveAdVideoUrl = FALLBACK_VIDEO_PATH;
    } catch (err) {
      console.error("[Ad] Local fallback error:", err.message);
      actualAdH = DEFAULT_AD_H;
    }
  }

  const canvasH = liveAdVideoUrl ? H : H + actualAdH;
  console.log(`[Canvas] poster=${H}px  adStrip=${actualAdH}px  liveVideoAd=${!!liveAdVideoUrl}  canvasH=${canvasH}px`);

  const canvas = createCanvas(W, canvasH);
  const ctx    = canvas.getContext("2d");

  // ── 1. Measure the headline ─────────────────────────────────
  const copy   = buildCopy(newsItem);
  let layout   = null;
  let startY   = TEXT_TOP;
  const availH = TEXT_BOTTOM - TEXT_TOP;

  if (copy.head) {
    layout = layoutPoster(ctx, copy, availH);
    startY = Math.round(TEXT_TOP + Math.max(0, availH - layout.total) * 0.35);
  }

  // ── 2. White background ─────────────────────────────────────
  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, W, canvasH);

  // ── 3. Rounded photo box + date ─────────────────────────────
  const photoSources = getPhotoSources(newsItem);
  if (photoSources.length || newsItem.showPhoto !== false) {
    await drawPhotos(ctx, photoSources, direction && direction.focus);
  }
  drawDate(ctx, newsItem);

  // ── 4. Headline (red) + sub-headline (black) ────────────────
  if (layout) drawCopy(ctx, layout, startY);

  // ── 5. Channel bar (flashkeralam), then logo on top of it ───
  if (newsItem.showFooter !== false) {
    drawSiteBar(ctx, newsItem);
    await drawLogo(ctx, newsItem);
  }

  // ── 6. Reset ────────────────────────────────────────────────
  ctx.textAlign    = "left";
  ctx.textBaseline = "alphabetic";

  // ── 7. Ad strip ─────────────────────────────────────────────
  if (!liveAdVideoUrl) {
    drawAdStrip(ctx, adImg, H, actualAdH);
  }

  const buffer = await canvasToBuffer(canvas, "image/png");
  return { type: "image", buffer, liveAdVideoUrl, adH: actualAdH };
}

module.exports = { createNewsPoster, toNodeBuffer };
