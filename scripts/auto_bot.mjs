#!/usr/bin/env node
/**
 * OBSIDIAN DIAMOND V18.5 — Autonomous Daily Scanner, Auto-Settle, 5W1H Learner & Telegram Bot
 * Runs on GitHub Actions (Node 22, zero external dependencies).
 * Reads secrets ONLY from environment variables:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, API_FOOTBALL_KEY (optional)
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const MEMORY_PATH = path.join(DATA_DIR, "memory.json");
const PICKS_PATH = path.join(DATA_DIR, "daily_picks.json");
const NEWS_PATH = path.join(DATA_DIR, "news_intel.json");
const EMOJI_CACHE_PATH = path.join(DATA_DIR, "emoji_cache.json");
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://enginebola.web.id/";

const TZ_AMT = "Asia/Yerevan";
const TZ_WIB = "Asia/Jakarta";

function fmtTime(d, tz) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}
function fmtDate(d, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function fmtKickoffDual(utcStr) {
  if (!utcStr) return "--:--";
  const d = new Date(utcStr);
  if (Number.isNaN(d.getTime())) return "--:--";
  const amt = fmtTime(d, TZ_AMT);
  const wib = fmtTime(d, TZ_WIB);
  const plus = fmtDate(d, TZ_WIB) !== fmtDate(d, TZ_AMT) ? " (+1)" : "";
  return `${amt} AMT / ${wib} WIB${plus}`;
}
function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function classifyHeadline(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(injured|injury|ruled out|hamstring|acl|knee|ankle|sidelined|fitness doubt|miss clash|blow)\b/.test(t)) return "INJURY_SHOCK";
  if (/\b(suspended|suspension|banned|red card|ban)\b/.test(t)) return "SUSPENSION_BAN";
  if (/\b(sacked|fired|crisis|dressing room|unrest|interim|new manager|boycott|strike)\b/.test(t)) return "MANAGER_CRISIS";
  if (/\b(rotate|rotation|rested|fringe players|second-string|youth squad)\b/.test(t)) return "ROTATION_HINT";
  if (/\b(returns|back in training|fit again|injury boost|available again)\b/.test(t)) return "SQUAD_BOOST";
  return "TEAM_NEWS";
}

function cleanTeamForQuery(name) {
  return String(name || "")
    .replace(/\b(FC|CF|SC|SK|FK|AC|AS|SS|UD|CD|SL|SV|VfB|VfL|RB|TSG)\b/gi, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchNewsIntelForMatch(homeName, awayName, newsApiKey) {
  if (!newsApiKey) return null;
  const hClean = cleanTeamForQuery(homeName);
  const aClean = cleanTeamForQuery(awayName);
  if (!hClean || !aClean) return null;
  const fromIso = new Date(Date.now() - 72 * 3600 * 1000).toISOString().slice(0, 10);
  const q = `("${hClean}" OR "${aClean}") AND (football OR soccer OR Champions OR League) AND (injury OR injured OR lineup OR suspended OR manager OR rotation OR squad OR fitness OR returns)`;
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&from=${fromIso}&language=en&sortBy=publishedAt&pageSize=6`;
  try {
    const resp = await fetch(url, { headers: { "X-Api-Key": newsApiKey, "User-Agent": "ObsidianV18/1.0" } });
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json.status !== "ok" || !Array.isArray(json.articles)) return null;
    const hLow = hClean.toLowerCase();
    const aLow = aClean.toLowerCase();
    const headlines = [];
    const seen = new Set();
    for (const art of json.articles) {
      const title = (art.title || "").trim();
      const desc = (art.description || "").trim();
      if (!title || title === "[Removed]") continue;
      const titleLow = title.toLowerCase();
      if (!titleLow.includes(hLow) && !titleLow.includes(aLow)) continue;
      const key = title.toLowerCase().slice(0, 50);
      if (seen.has(key)) continue;
      seen.add(key);
      headlines.push({
        title,
        source: art.source?.name || "News",
        published_at: art.publishedAt || null,
        url: art.url || null,
        tag: classifyHeadline(`${title} ${desc}`),
      });
      if (headlines.length >= 3) break;
    }
    const tags = [...new Set(headlines.map((h) => h.tag))];
    const riskLevel = tags.some((t) => t === "INJURY_SHOCK" || t === "MANAGER_CRISIS" || t === "SUSPENSION_BAN")
      ? "ALERT"
      : tags.includes("ROTATION_HINT")
        ? "WATCH"
        : tags.includes("SQUAD_BOOST")
          ? "BOOST"
          : "CLEAR";
    return {
      home: homeName,
      away: awayName,
      fetched_at: new Date().toISOString(),
      risk_level: riskLevel,
      signals: tags,
      headlines,
    };
  } catch {
    return null;
  }
}

function loadEngineSource() {
  const candidates = [
    path.join(ROOT, "docs", "engine.js"),
    path.join(ROOT, "index.html"),
    path.join(ROOT, "release", "index.html"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    if (file.endsWith(".js")) return raw;
    const startIdx = raw.indexOf("const ObsidianEngine = (() => {");
    if (startIdx >= 0) {
      const endMarker = "})();";
      const scriptEnd = raw.indexOf("</script>", startIdx);
      const endIdx = raw.lastIndexOf(endMarker, scriptEnd > 0 ? scriptEnd : raw.length);
      if (endIdx > startIdx) return raw.slice(startIdx, endIdx + endMarker.length);
    }
  }
  throw new Error("Could not find ObsidianEngine in index.html or docs/engine.js");
}

function createFileBackedStorage(memoryFile) {
  const store = {};
  if (fs.existsSync(memoryFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
      if (Array.isArray(parsed.predictions)) store["obsidian_v18_live_predictions"] = JSON.stringify(parsed.predictions);
      if (parsed.weights) store["obsidian_v18_live_weights"] = JSON.stringify(parsed.weights);
      if (Array.isArray(parsed.logs)) store["obsidian_v18_live_logs"] = JSON.stringify(parsed.logs);
      if (parsed.bankroll) store["obsidian_v18_bankroll"] = JSON.stringify(parsed.bankroll);
      if (parsed.usage) store["obsidian_v18_usage"] = JSON.stringify(parsed.usage);
    } catch (e) {
      console.warn("Could not parse existing memory.json, starting fresh:", e.message);
    }
  }
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _raw: store,
  };
}

// ---- Telegram Premium Custom Emoji Support (Bot API 9.4+) ----
const DEFAULT_EMOJI_PACKS = ["FootballTimeEmoji", "futbolga_doir"];

const FCPRICE_LEAGUE_INDICES = {
  stadium: 0,
  uefa: 1,
  fifa: 2,
  ucl: 3,
  ucl_ball: 4,
  uel: 5,
  uecl: 6,
  premier_league: 7,
  laliga: 8,
  serie_a: 9,
  bundesliga: 10,
  ligue_1: 11,
  liga_portugal: 12,
  saudi_pro_league: 13,
  eredivisie: 14,
  super_lig: 15,
  rpl: 16,
  mls: 17,
  euro: 18,
  copa_america: 19,
  ucl_trophy: 20,
  uel_trophy: 21,
  uecl_trophy: 22,
  world_cup: 23,
};

const FCPRICE_CLUB_INDICES = {
  real_madrid: 27,
  barcelona: 28,
  man_city: 29,
  ac_milan: 30,
  juventus: 31,
  man_utd: 32,
  bayern: 33,
  dortmund: 34,
  psg: 35,
  atletico: 36,
  inter: 37,
  napoli: 38,
  arsenal: 39,
};

function singleAltEmoji(str, fallback = "⚽") {
  const s = String(str || "").trim();
  if (!s) return fallback;
  try {
    const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
    const parts = [...seg.segment(s)].map((x) => x.segment).filter(Boolean);
    if (parts.length >= 2 && /^[🟠🟢🔵🟣🟡⚪🔴⚫]$/.test(parts[0])) return parts[1];
    return parts[0] || fallback;
  } catch {
    return [...s][0] || fallback;
  }
}

function stripTgEmojiTags(html) {
  return String(html || "").replace(/<tg-emoji\s+emoji-id="[^"]+">([\s\S]*?)<\/tg-emoji>/g, "$1");
}

function visibleTextLen(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .length;
}

function wrapTgEmoji(customEmojiId, fallbackEmoji) {
  if (!customEmojiId) return fallbackEmoji;
  const alt = singleAltEmoji(fallbackEmoji, "⚽");
  return `<tg-emoji emoji-id="${String(customEmojiId)}">${alt}</tg-emoji>`;
}

function matchLeagueCustomKey(leagueName) {
  const n = String(leagueName || "").toLowerCase();
  if (n.includes("champions league") && !n.includes("afc") && !n.includes("concacaf") && !n.includes("caf")) return "ucl";
  if (n.includes("europa league")) return "uel";
  if (n.includes("conference league")) return "uecl";
  if (n.includes("world cup")) return "world_cup";
  if (n.includes("euro ") || n === "euro" || n.includes("european championship")) return "euro";
  if (n.includes("copa america") || n.includes("copa américa")) return "copa_america";
  if (n.includes("premier league") && !n.includes("russia") && !n.includes("egypt") && !n.includes("scot") && !n.includes("ukraine") && !n.includes("israel") && !n.includes("armenia")) return "premier_league";
  if (n.includes("laliga") || n.includes("la liga")) return "laliga";
  if (n === "serie a" || (n.includes("serie a") && !n.includes("brasil") && !n.includes("ecuador"))) return "serie_a";
  if (n === "bundesliga" || (n.includes("bundesliga") && !n.includes("2.") && !n.includes("austria"))) return "bundesliga";
  if (n === "ligue 1" || (n.includes("ligue 1") && !n.includes("tunisia") && !n.includes("algeria"))) return "ligue_1";
  if (n.includes("liga portugal") || n.includes("primeira liga")) return "liga_portugal";
  if (n.includes("saudi pro") || n.includes("roshn saudi")) return "saudi_pro_league";
  if (n.includes("eredivisie")) return "eredivisie";
  if (n.includes("super lig") || n.includes("süper lig")) return "super_lig";
  if (n.includes("russian premier")) return "rpl";
  if (n === "mls" || n.includes("major league soccer")) return "mls";
  if (n.includes("uefa") || n.includes("nations league")) return "uefa";
  if (n.includes("fifa")) return "fifa";
  return null;
}

function matchClubCustomKey(teamName) {
  const t = String(teamName || "").toLowerCase().trim();
  if (/\breal madrid\b/.test(t)) return "real_madrid";
  if (/\b(fc )?barcelona\b/.test(t) && !t.includes("sc") && !t.includes("guayaquil")) return "barcelona";
  if (/\bman(chester)? city\b/.test(t)) return "man_city";
  if (/\b(ac )?milan\b/.test(t) && !t.includes("inter")) return "ac_milan";
  if (/\bjuventus\b/.test(t)) return "juventus";
  if (/\bman(chester)? (united|utd)\b/.test(t)) return "man_utd";
  if (/\bbayern\b/.test(t)) return "bayern";
  if (/\b(borussia )?dortmund\b/.test(t)) return "dortmund";
  if (/\b(paris saint[- ]germain|psg)\b/.test(t)) return "psg";
  if (/\batl[eé]tico( de)? madrid\b/.test(t)) return "atletico";
  if (/\binter(nazionale| milan)?\b/.test(t) && !t.includes("miami") && !t.includes("internacional") && !t.includes("turku")) return "inter";
  if (/\bnapoli\b/.test(t)) return "napoli";
  if (/\barsenal\b/.test(t) && !t.includes("sarandi") && !t.includes("tula")) return "arsenal";
  return null;
}

async function loadCustomEmojiPacks(token) {
  const resolver = {
    enabled: false,
    leagues: {},
    clubs: {},
    ui: {},
    leagueIcon(leagueName, fallbackEmoji) {
      const k = matchLeagueCustomKey(leagueName);
      const id = k ? this.leagues[k] : null;
      return id ? wrapTgEmoji(id, fallbackEmoji) : fallbackEmoji;
    },
    teamIcon(teamName, fallbackFlag) {
      const k = matchClubCustomKey(teamName);
      const id = k ? this.clubs[k] : null;
      return id ? wrapTgEmoji(id, fallbackFlag) : fallbackFlag;
    },
    uiIcon(key, fallbackChar) {
      const id = this.ui[key] || (key === "ball" ? this.leagues.ucl_ball : null) || (key === "stadium" ? this.leagues.stadium : null);
      return id ? wrapTgEmoji(id, fallbackChar) : fallbackChar;
    },
  };

  // Optional custom overrides via env JSON (never required)
  const extraJson = (process.env.CUSTOM_EMOJI_MAP_JSON || "").trim();
  if (extraJson) {
    try {
      const parsed = JSON.parse(extraJson);
      if (parsed.leagues) Object.assign(resolver.leagues, parsed.leagues);
      if (parsed.clubs) Object.assign(resolver.clubs, parsed.clubs);
      if (parsed.ui) Object.assign(resolver.ui, parsed.ui);
      resolver.enabled = true;
    } catch {}
  }

  const cleanToken = String(token || "").replace(/^["']|["']$/g, "").trim();
  if (!cleanToken) return resolver;

  const packNames = String(process.env.TELEGRAM_EMOJI_PACKS || DEFAULT_EMOJI_PACKS.join(","))
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const uiEmojiCandidates = {
    ball: ["⚽"],
    radar: ["📡", "🛰️", "🔍", "⚡"],
    target: ["🎯", "⭐", "💎"],
    trophy: ["🏆", "🥇"],
    fire: ["🔥", "💥"],
    corner: ["🚩", "📐"],
    chart: ["📊", "📈"],
    ticket: ["🎟️", "🎫"],
    shift: ["🔄", "🔁", "⚠️"],
    stadium: ["🏟️"],
  };

  for (const name of packNames) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${cleanToken}/getStickerSet?name=${encodeURIComponent(name)}`);
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json.ok || !Array.isArray(json.result?.stickers)) {
        console.warn(`[CustomEmoji] Pack "${name}" unavailable (HTTP ${resp.status}: ${json?.description || "not found"}).`);
        continue;
      }
      const title = json.result.title || name;
      const stickers = json.result.stickers;
      const animCount = stickers.filter((s) => s.is_animated || s.is_video).length;
      console.log(`[CustomEmoji] Loaded "${name}" ("${title}"): ${stickers.length} icons (${animCount} animated).`);

      // Match the @FCprice Champions League / Leagues & Clubs grid pack (157 icons)
      const isFcPricePack = /fcprice|лига чемпионов|champions/i.test(title) || stickers.length >= 140;
      if (isFcPricePack) {
        for (const [k, idx] of Object.entries(FCPRICE_LEAGUE_INDICES)) {
          const cid = stickers[idx]?.custom_emoji_id;
          if (cid && !resolver.leagues[k]) resolver.leagues[k] = cid;
        }
        for (const [k, idx] of Object.entries(FCPRICE_CLUB_INDICES)) {
          const cid = stickers[idx]?.custom_emoji_id;
          if (cid && !resolver.clubs[k]) resolver.clubs[k] = cid;
        }
        resolver.enabled = true;
      }

      // Scan packs for animated/custom UI icons matching their base Unicode emoji (preferring animated icons!).
      // Skip static stickers from the @FCprice club/league grid because league crests (e.g. LaLiga) share base emoji "⚽".
      for (const [uiKey, baseList] of Object.entries(uiEmojiCandidates)) {
        const matches = stickers.filter((s) =>
          s.custom_emoji_id &&
          baseList.includes(s.emoji) &&
          (!isFcPricePack || s.is_animated || s.is_video)
        );
        if (!matches.length) continue;
        const animHit = matches.find((s) => s.is_animated || s.is_video);
        const pick = animHit || (uiKey === "ball" ? null : matches[0]);
        if (!pick) continue;
        // Prefer animated icon over static icon if both packs provide one
        if (!resolver.ui[uiKey] || (animHit && !resolver.ui[`${uiKey}_anim`])) {
          resolver.ui[uiKey] = pick.custom_emoji_id;
          if (animHit) resolver.ui[`${uiKey}_anim`] = true;
          resolver.enabled = true;
        }
      }
    } catch (e) {
      console.warn(`[CustomEmoji] Pack "${name}" fetch error: ${e?.message || e}`);
    }
  }

  console.log(`[CustomEmoji] Ready: enabled=${resolver.enabled} | leagues=${Object.keys(resolver.leagues).length} | clubs=${Object.keys(resolver.clubs).length} | ui=${Object.keys(resolver.ui).filter((k) => !k.endsWith("_anim")).length}`);
  return resolver;
}

// ---- Zero-Dependency Pure-Node 100x100 Transparent PNG Resizer (for Telegram Custom Emoji) ----
const PNG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function pngCrc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = PNG_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(pngCrc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function decodePngToRgba(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) throw new Error("Not a valid PNG");
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error("Invalid PNG signature");

  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let plte = null, trns = null;
  const idatChunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      plte = data;
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!width || !height || interlace !== 0) throw new Error(`Unsupported PNG (${width}x${height}, interlace=${interlace})`);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`Unsupported PNG colorType=${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const recon = new Uint8Array(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
  };

  let inPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[inPos++];
    const rowOff = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[inPos++];
      const a = x >= bpp ? recon[rowOff + x - bpp] : 0;
      const b = y > 0 ? recon[rowOff - stride + x] : 0;
      const c = (x >= bpp && y > 0) ? recon[rowOff - stride + x - bpp] : 0;
      let val = v;
      if (filter === 1) val = (v + a) & 0xff;
      else if (filter === 2) val = (v + b) & 0xff;
      else if (filter === 3) val = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) val = (v + paeth(a, b, c)) & 0xff;
      recon[rowOff + x] = val;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  const sampleAt = (rowOff, idx) => {
    if (bitDepth === 8) return recon[rowOff + idx];
    if (bitDepth === 16) return recon[rowOff + idx * 2];
    const perByte = 8 / bitDepth;
    const mask = (1 << bitDepth) - 1;
    const byteVal = recon[rowOff + Math.floor(idx / perByte)];
    const shift = 8 - bitDepth * ((idx % perByte) + 1);
    return (byteVal >> shift) & mask;
  };
  const scaleGray = (v) => (bitDepth < 8 ? Math.round((v * 255) / ((1 << bitDepth) - 1)) : v);

  for (let y = 0; y < height; y++) {
    const rowOff = y * stride;
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      if (colorType === 6) {
        rgba[dst] = sampleAt(rowOff, x * 4);
        rgba[dst + 1] = sampleAt(rowOff, x * 4 + 1);
        rgba[dst + 2] = sampleAt(rowOff, x * 4 + 2);
        rgba[dst + 3] = sampleAt(rowOff, x * 4 + 3);
      } else if (colorType === 2) {
        const r = sampleAt(rowOff, x * 3), g = sampleAt(rowOff, x * 3 + 1), b = sampleAt(rowOff, x * 3 + 2);
        let a = 255;
        if (trns && trns.length >= 6 && r === trns[1] && g === trns[3] && b === trns[5]) a = 0;
        rgba[dst] = r; rgba[dst + 1] = g; rgba[dst + 2] = b; rgba[dst + 3] = a;
      } else if (colorType === 3) {
        const pi = sampleAt(rowOff, x);
        rgba[dst] = plte ? (plte[pi * 3] || 0) : 0;
        rgba[dst + 1] = plte ? (plte[pi * 3 + 1] || 0) : 0;
        rgba[dst + 2] = plte ? (plte[pi * 3 + 2] || 0) : 0;
        rgba[dst + 3] = (trns && pi < trns.length) ? trns[pi] : 255;
      } else if (colorType === 4) {
        const g = scaleGray(sampleAt(rowOff, x * 2));
        rgba[dst] = g; rgba[dst + 1] = g; rgba[dst + 2] = g;
        rgba[dst + 3] = sampleAt(rowOff, x * 2 + 1);
      } else if (colorType === 0) {
        const gv = sampleAt(rowOff, x);
        const g = scaleGray(gv);
        let a = 255;
        if (trns && trns.length >= 2 && gv === trns[1]) a = 0;
        rgba[dst] = g; rgba[dst + 1] = g; rgba[dst + 2] = g; rgba[dst + 3] = a;
      }
    }
  }
  return { width, height, rgba };
}

function encodeRgbaToPng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const outRow = y * (1 + stride);
    raw[outRow] = 0; // filter None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, outRow + 1);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function resizePngTo100x100(pngBuf) {
  const { width: sw, height: sh, rgba: src } = decodePngToRgba(pngBuf);
  const CANVAS = 100;
  const FIT = 94; // subtle 3px transparent breathing room so crests never clip
  const scale = Math.min(FIT / sw, FIT / sh);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const ox = Math.floor((CANVAS - dw) / 2);
  const oy = Math.floor((CANVAS - dh) / 2);
  const dst = new Uint8Array(CANVAS * CANVAS * 4);

  // Premultiplied-alpha area-box resampling prevents dark/white halos on transparent edges
  const rx = sw / dw, ry = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * ry, y1 = Math.min(sh, (y + 1) * ry);
    const iy0 = Math.floor(y0), iy1 = Math.min(sh - 1, Math.ceil(y1) - 1);
    for (let x = 0; x < dw; x++) {
      const x0 = x * rx, x1 = Math.min(sw, (x + 1) * rx);
      const ix0 = Math.floor(x0), ix1 = Math.min(sw - 1, Math.ceil(x1) - 1);
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0, wSum = 0;
      for (let sy = iy0; sy <= iy1; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = ix0; sx <= ix1; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const p = (sy * sw + sx) * 4;
          const a = src[p + 3] / 255;
          rSum += src[p] * a * w;
          gSum += src[p + 1] * a * w;
          bSum += src[p + 2] * a * w;
          aSum += a * w;
          wSum += w;
        }
      }
      const di = ((oy + y) * CANVAS + (ox + x)) * 4;
      if (wSum > 0 && aSum > 0.001) {
        dst[di] = Math.min(255, Math.round(rSum / aSum));
        dst[di + 1] = Math.min(255, Math.round(gSum / aSum));
        dst[di + 2] = Math.min(255, Math.round(bSum / aSum));
        dst[di + 3] = Math.min(255, Math.round((aSum / wSum) * 255));
      }
    }
  }
  return encodeRgbaToPng(CANVAS, CANVAS, dst);
}

// ---- Dynamic Bot-Owned Custom Emoji Pack Auto-Generator (Auto-200 Rollover + Git-Persisted Cache) ----
function loadDynamicEmojiCache(memoryPath, cachePath) {
  const merged = { teams: {}, leagues: {}, pack_index: 1 };
  // 1. Load from memory.json (always committed by existing GitHub Actions workflow!)
  if (fs.existsSync(memoryPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(memoryPath, "utf8"));
      if (m?.emoji_cache?.teams) Object.assign(merged.teams, m.emoji_cache.teams);
      if (m?.emoji_cache?.leagues) Object.assign(merged.leagues, m.emoji_cache.leagues);
      if (m?.emoji_cache?.pack_index) merged.pack_index = Math.max(1, Number(m.emoji_cache.pack_index));
    } catch {}
  }
  // 2. Overlay dedicated emoji_cache.json if present
  if (fs.existsSync(cachePath)) {
    try {
      const c = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (c?.teams) Object.assign(merged.teams, c.teams);
      if (c?.leagues) Object.assign(merged.leagues, c.leagues);
      if (c?.pack_index) merged.pack_index = Math.max(merged.pack_index, Number(c.pack_index));
    } catch {}
  }
  return merged;
}

function saveDynamicEmojiCache(cacheObj, cachePath, memoryPath) {
  try {
    fs.writeFileSync(cachePath, JSON.stringify(cacheObj, null, 2), "utf8");
  } catch {}
  // Also mirror into memory.json so existing GitHub Actions commits persist it automatically!
  if (fs.existsSync(memoryPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(memoryPath, "utf8"));
      m.emoji_cache = cacheObj;
      fs.writeFileSync(memoryPath, JSON.stringify(m, null, 2), "utf8");
    } catch {}
  }
}

async function createDynamicBadgeEngine({ token, ownerId, botUsername, basePack }) {
  const cleanToken = String(token || "").replace(/^["']|["']$/g, "").trim();
  const cleanOwner = String(ownerId || "").trim();
  const cleanBot = String(botUsername || "").replace(/^@/, "").trim().toLowerCase();
  const cache = loadDynamicEmojiCache(MEMORY_PATH, EMOJI_CACHE_PATH);
  const canUpload = !!(cleanToken && /^\d+$/.test(cleanOwner) && cleanBot);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let uploadsThisRun = 0;
  let dirty = false;
  const MAX_UPLOADS = parseInt(process.env.MAX_EMOJI_UPLOADS || "24", 10);

  async function registerPngAsCustomEmoji(pngBuf, altEmoji) {
    if (!canUpload || uploadsThisRun >= MAX_UPLOADS) return null;
    const png100 = resizePngTo100x100(pngBuf);
    if (png100.length > 64 * 1024) throw new Error(`Resized PNG too large (${png100.length} bytes)`);

    // Auto-rollover every 200 badges (Telegram's hard limit per custom_emoji sticker set)
    let packIdx = Math.max(1, Number(cache.pack_index || 1));
    let setName = "";
    let setExists = false;
    for (let guard = 0; guard < 15; guard++) {
      setName = `enginebola_badges_${packIdx}_by_${cleanBot}`;
      const chkResp = await fetch(`https://api.telegram.org/bot${cleanToken}/getStickerSet?name=${encodeURIComponent(setName)}`);
      const chkJson = await chkResp.json().catch(() => ({}));
      if (chkResp.ok && chkJson.ok && Array.isArray(chkJson.result?.stickers)) {
        if (chkJson.result.stickers.length >= 200) {
          packIdx++;
          continue;
        }
        setExists = true;
        break;
      } else {
        setExists = false;
        break;
      }
    }
    cache.pack_index = packIdx;

    const stickerMeta = {
      sticker: "attach://badge",
      format: "static",
      emoji_list: [singleAltEmoji(altEmoji, "⚽")],
    };
    const fd = new FormData();
    fd.append("user_id", cleanOwner);
    fd.append("name", setName);
    if (!setExists) {
      fd.append("title", `Engine Bola Badges #${packIdx}`);
      fd.append("sticker_type", "custom_emoji");
      fd.append("stickers", JSON.stringify([stickerMeta]));
    } else {
      fd.append("sticker", JSON.stringify(stickerMeta));
    }
    fd.append("badge", new Blob([png100], { type: "image/png" }), "badge.png");

    const method = setExists ? "addStickerToSet" : "createNewStickerSet";
    const upResp = await fetch(`https://api.telegram.org/bot${cleanToken}/${method}`, { method: "POST", body: fd });
    const upJson = await upResp.json().catch(() => ({}));
    if (!upResp.ok || !upJson.ok) {
      throw new Error(`${method} failed: ${upJson?.description || upResp.status}`);
    }

    // Retrieve the newly created custom_emoji_id from the updated set
    const getResp = await fetch(`https://api.telegram.org/bot${cleanToken}/getStickerSet?name=${encodeURIComponent(setName)}`);
    const getJson = await getResp.json().catch(() => ({}));
    const stickers = getJson?.result?.stickers || [];
    const newId = stickers[stickers.length - 1]?.custom_emoji_id || null;
    if (newId) {
      uploadsThisRun++;
      dirty = true;
      await sleep(350);
    }
    return newId;
  }

  async function downloadFirstPng(urls) {
    for (const u of urls) {
      try {
        const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 100 && buf[0] === 0x89 && buf[1] === 0x50) return buf;
      } catch {}
    }
    return null;
  }

  async function prewarmTeam(teamId, teamName, fallbackEmoji) {
    const id = String(teamId || "").trim();
    if (!id || id.startsWith("espn:") || !/^\d+$/.test(id)) return;
    if (cache.teams[id]) return;
    // Skip upload if already covered by existing FootballTimeEmoji / futbolga_doir pack
    const existingPackKey = matchClubCustomKey(teamName);
    if (existingPackKey && basePack?.clubs?.[existingPackKey]) return;
    if (!canUpload || uploadsThisRun >= MAX_UPLOADS) return;
    try {
      const png = await downloadFirstPng([
        `https://images.fotmob.com/image_resources/logo/teamlogo/${id}.png`,
        `https://images.fotmob.com/image_resources/logo/teamlogo/${id}_small.png`,
      ]);
      if (!png) return;
      const cid = await registerPngAsCustomEmoji(png, fallbackEmoji || "⚽");
      if (cid) {
        cache.teams[id] = cid;
        console.log(`[AutoBadge] Registered team crest: ${teamName} (#${id}) -> ${cid}`);
      }
    } catch (e) {
      console.warn(`[AutoBadge] Team ${teamName} (#${id}) skipped: ${e?.message || e}`);
    }
  }

  async function prewarmLeague(leagueId, leagueName, fallbackEmoji) {
    const id = String(leagueId || "").trim();
    if (!id || !/^\d+$/.test(id)) return;
    if (cache.leagues[id]) return;
    const existingPackKey = matchLeagueCustomKey(leagueName);
    if (existingPackKey && basePack?.leagues?.[existingPackKey]) return;
    if (!canUpload || uploadsThisRun >= MAX_UPLOADS) return;
    try {
      const png = await downloadFirstPng([
        `https://images.fotmob.com/image_resources/logo/leaguelogo/dark/${id}.png`,
        `https://images.fotmob.com/image_resources/logo/leaguelogo/${id}.png`,
      ]);
      if (!png) return;
      const cid = await registerPngAsCustomEmoji(png, fallbackEmoji || "🏆");
      if (cid) {
        cache.leagues[id] = cid;
        console.log(`[AutoBadge] Registered league logo: ${leagueName} (#${id}) -> ${cid}`);
      }
    } catch (e) {
      console.warn(`[AutoBadge] League ${leagueName} (#${id}) skipped: ${e?.message || e}`);
    }
  }

  return {
    canUpload,
    cache,
    async prewarmBatch(items) {
      const seenT = new Set();
      const seenL = new Set();
      for (const it of items) {
        if (it.leagueId && !seenL.has(String(it.leagueId))) {
          seenL.add(String(it.leagueId));
          await prewarmLeague(it.leagueId, it.leagueName, it.leagueFallback);
        }
        if (it.homeId && !seenT.has(String(it.homeId))) {
          seenT.add(String(it.homeId));
          await prewarmTeam(it.homeId, it.homeName, it.homeFallback);
        }
        if (it.awayId && !seenT.has(String(it.awayId))) {
          seenT.add(String(it.awayId));
          await prewarmTeam(it.awayId, it.awayName, it.awayFallback);
        }
      }
      if (dirty) {
        saveDynamicEmojiCache(cache, EMOJI_CACHE_PATH, MEMORY_PATH);
        console.log(`[AutoBadge] Saved cache: ${Object.keys(cache.teams).length} teams, ${Object.keys(cache.leagues).length} leagues (pack #${cache.pack_index}, +${uploadsThisRun} new).`);
      }
    },
    teamIcon(teamId, teamName, fallbackFlag) {
      const id = String(teamId || "").trim();
      if (id && cache.teams[id]) return wrapTgEmoji(cache.teams[id], fallbackFlag);
      return basePack.teamIcon(teamName, fallbackFlag);
    },
    leagueIcon(leagueId, leagueName, fallbackEmoji) {
      const id = String(leagueId || "").trim();
      if (id && cache.leagues[id]) return wrapTgEmoji(cache.leagues[id], fallbackEmoji);
      return basePack.leagueIcon(leagueName, fallbackEmoji);
    },
    uiIcon(key, fallbackChar) {
      return basePack.uiIcon(key, fallbackChar);
    },
  };
}

function chunkTelegramHtml(htmlText) {
  const chunks = [];
  if (visibleTextLen(htmlText) <= 3850 && htmlText.length <= 14000) {
    chunks.push(htmlText);
  } else {
    let cur = "";
    for (const block of htmlText.split("\n\n")) {
      const candidate = cur ? `${cur}\n\n${block}` : block;
      if ((visibleTextLen(candidate) > 3750 || candidate.length > 13500) && cur) {
        chunks.push(cur);
        cur = block;
      } else {
        cur = candidate;
      }
    }
    if (cur) chunks.push(cur);
  }
  return chunks;
}

async function sendTelegram(token, chatId, htmlText, channelFallbackHtml = null, chatTypeMap = {}, opts = {}) {
  if (!token || !chatId) {
    console.log("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — printing message to stdout instead:\n" + htmlText);
    return { skipped: true };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cleanToken = String(token || "").replace(/^["']|["']$/g, "").trim();
  const chatIds = [...new Set(
    String(chatId || "")
      .replace(/^["']|["']$/g, "")
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  )];

  if (!chatIds.length) {
    console.log("TELEGRAM_CHAT_ID empty — skipping Telegram send.");
    return { skipped: true };
  }

  // Safe diagnostic (prints zero secrets): token SHAPE only + bot identity + webhook state
  const shapeOk = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(cleanToken);
  const idsValid = chatIds.every((id) => /^-?\d+$/.test(id) || /^@[A-Za-z0-9_]{4,}$/.test(id));
  console.log(`[Telegram Token Shape] len=${cleanToken.length} format=${shapeOk ? "OK" : "INVALID"} whitespace=${/\s/.test(String(token))} quotes=${/["']/.test(String(token))} | recipients=${chatIds.length} valid=${idsValid}`);
  try {
    const meR = await fetch(`https://api.telegram.org/bot${cleanToken}/getMe`);
    const meJ = await meR.json().catch(() => ({}));
    const whR = await fetch(`https://api.telegram.org/bot${cleanToken}/getWebhookInfo`);
    const whJ = await whR.json().catch(() => ({}));
    console.log(`[Telegram Check] getMe HTTP ${meR.status} ok=${meJ.ok} bot=@${meJ.result?.username || "?"} ${meJ.ok ? "" : `desc="${meJ.description || "?"}"`} | webhook=${whJ.result?.url ? "ACTIVE" : "none"} | pending_updates=${whJ.result?.pending_update_count ?? 0}`);
    if (meR.status === 401 || meR.status === 404) {
      throw new Error(`Telegram token rejected (getMe ${meR.status}) — token salah/sudah di-revoke. Update secret TELEGRAM_BOT_TOKEN.`);
    }
    if (meR.status === 429) {
      throw new Error(`Telegram token throttled at TOKEN level (getMe 429, retry_after=${meJ?.parameters?.retry_after}). Bukan masalah pesan/IP — /revoke token di @BotFather atau buat bot baru, lalu update secret TELEGRAM_BOT_TOKEN.`);
    }
  } catch (e) {
    if (String(e?.message || "").startsWith("Telegram token")) throw e;
  }

  const richChunks = chunkTelegramHtml(htmlText);
  const chanChunks = channelFallbackHtml ? chunkTelegramHtml(channelFallbackHtml) : richChunks;
  const forceChannelCustom = String(process.env.FORCE_CHANNEL_CUSTOM_EMOJI || "").toLowerCase() === "true";
  const premiumDisabled =
    String(process.env.DISABLE_PREMIUM_PUBLISHER || "").toLowerCase() === "true" ||
    opts?.premiumPublisherEnabled === false;
  const hasPremiumPublisher = !premiumDisabled && Boolean(
    String(process.env.TG_API_ID || "").trim() &&
    String(process.env.TG_API_HASH || "").trim() &&
    String(process.env.TG_SESSION_STRING || "").trim()
  );
  if (premiumDisabled) {
    console.log("[PremiumPublisher] Kill-switch active (disabled via KV/env) — using Bot API directly for broadcast channels.");
  }
  const pendingPath = path.join(DATA_DIR, "pending_channel_post.json");
  const delegatedChannels = [];

  const results = [];
  for (let rIdx = 0; rIdx < chatIds.length; rIdx++) {
    const targetId = chatIds[rIdx];
    let chatType = chatTypeMap?.[targetId] || "";
    if (!chatType) {
      if (/^\d{6,}$/.test(targetId)) {
        chatType = "private";
      } else {
        try {
          const cR = await fetch(`https://api.telegram.org/bot${cleanToken}/getChat?chat_id=${encodeURIComponent(targetId)}`);
          const cJ = await cR.json().catch(() => ({}));
          if (cR.ok && cJ.ok && cJ.result?.type) chatType = cJ.result.type;
        } catch {}
      }
    }
    const isBroadcastChannel = chatType === "channel" || (!chatType && targetId.startsWith("@"));
    if (isBroadcastChannel && hasPremiumPublisher) {
      delegatedChannels.push(targetId);
      results.push({ recipient: rIdx + 1, type: "channel", mode: "delegated_to_premium_mtproto", ok: true });
      console.log(`[PremiumPublisher Handoff] Queued ${targetId} for FULL club-crest MTProto channel publish (auto-forwards full crests to Discussion Group).`);
      continue;
    }
    const useChannelFallback = isBroadcastChannel && !forceChannelCustom && !!channelFallbackHtml;
    const chunks = useChannelFallback ? chanChunks : richChunks;
    let recipientOk = true;
    let lastErr = null;
    let stripCustomEmoji = false;
    for (let i = 0; i < chunks.length; i++) {
      let sent = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        // On retry after 429, drop inline_keyboard & use plain dashboard link in case Telegram throttles URL buttons on new bots
        const useButton = (attempt === 1 || stripCustomEmoji) && i === chunks.length - 1;
        const baseChunk = stripCustomEmoji ? stripTgEmojiTags(chunks[i]) : chunks[i];
        const textOut = (!useButton && i === chunks.length - 1)
          ? `${baseChunk}\n\n🔗 ${DASHBOARD_URL}`
          : baseChunk;
        const body = {
          chat_id: targetId,
          text: textOut,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        };
        if (useButton) {
          body.reply_markup = {
            inline_keyboard: [[{ text: "Buka VIP Dashboard · Engine Bola", url: DASHBOARD_URL }]],
          };
        }

        const resp = await fetch(`https://api.telegram.org/bot${cleanToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await resp.json().catch(() => ({}));
        if (resp.ok && json.ok) {
          sent = true;
          break;
        }
        // Automatic safe fallback if Telegram rejects <tg-emoji> on a channel or non-eligible chat
        if (resp.status === 400 && !stripCustomEmoji && /<tg-emoji\b/.test(chunks[i])) {
          console.warn(`[Telegram CustomEmoji Fallback] Recipient #${rIdx + 1} returned HTTP 400 (${json?.description || "?"}) — retrying cleanly with Unicode flag/emoji fallback...`);
          stripCustomEmoji = true;
          continue;
        }
        if (resp.status === 429 && attempt < 3) {
          const waitSec = Math.min(75, Math.max(5, Number(json?.parameters?.retry_after || 20) + 5));
          console.warn(`[Telegram 429] Recipient #${rIdx + 1} rate limited (retry_after=${json?.parameters?.retry_after}) — waiting ${waitSec}s before retry ${attempt + 1}/3...`);
          await sleep(waitSec * 1000);
          continue;
        }
        lastErr = `HTTP ${resp.status}: ${json?.description || JSON.stringify(json)}`;
        break;
      }
      if (!sent) {
        recipientOk = false;
        console.warn(`[Telegram] Recipient #${rIdx + 1} failed: ${lastErr || "unknown error"}`);
        break;
      }
      if (i < chunks.length - 1) await sleep(1200);
    }
    results.push({ recipient: rIdx + 1, type: chatType || "unknown", mode: useChannelFallback ? "channel_unicode" : "premium_custom_emoji", ok: recipientOk, custom_emoji_stripped: stripCustomEmoji, ...(lastErr ? { error: lastErr } : {}) });
    if (rIdx < chatIds.length - 1) await sleep(1200);
  }

  if (delegatedChannels.length) {
    try {
      fs.writeFileSync(
        pendingPath,
        JSON.stringify({
          created_at: new Date().toISOString(),
          targets: delegatedChannels,
          expected_owner_id: String(opts?.ownerId || "").trim() || null,
          dashboard_url: DASHBOARD_URL,
          html: htmlText,
          channel_fallback_html: channelFallbackHtml || stripTgEmojiTags(htmlText),
        }, null, 2),
        "utf8"
      );
    } catch (e) {
      console.warn(`[PremiumPublisher Handoff] Failed to write pending payload: ${e?.message || e}`);
    }
  } else if (fs.existsSync(pendingPath)) {
    try { fs.unlinkSync(pendingPath); } catch {}
  }

  const delivered = results.filter((r) => r.ok).length;
  if (delivered === 0) {
    throw new Error(`Telegram sendMessage failed for all ${chatIds.length} recipient(s): ${results[0]?.error || "unknown"}`);
  }
  return { ok: delivered === chatIds.length, delivered, total: chatIds.length, delegated_channels: delegatedChannels, results };
}

function rcShort(code) {
  const map = {
    HIERARCHY_TRIUMPH: "Analisis Tepat",
    PROTECTED_REFUND: "Proteksi Modal Kembali",
    LINEUP_ROTATION_SHOCK: "Rotasi Susunan Pemain",
    SQUAD_INJURY_CRISIS: "Krisis Cedera Skuad",
    FATIGUE_HANGOVER_SHOCK: "Kelelahan Jadwal Padat",
    FILTER_WARNING_IGNORED: "Peringatan Risiko",
    DATA_GAP_UNDER_SAMPLE: "Data Terbatas",
    OVERCONFIDENT_LAMBDA_BIAS: "Kalibrasi Tempo Gol",
    BLACK_SWAN_VARIANCE: "Variansi Penyelesaian",
  };
  return map[code] || code || "Evaluasi Umum";
}

function fmtDateIndo(dateObj) {
  try {
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: TZ_WIB,
      weekday: "long",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(dateObj);
  } catch {
    return fmtDate(dateObj, TZ_WIB);
  }
}

function stakeDescriptor(u) {
  const v = Number(u || 0);
  if (v >= 3.0) return `Tinggi (${v}u)`;
  if (v >= 1.75) return `Normal (${v}u)`;
  if (v >= 1.0) return `Sedang (${v}u)`;
  return `Ringan (${v}u)`;
}

function newsTagIndo(tag) {
  const map = {
    INJURY_SHOCK: "Info Cedera",
    SUSPENSION_BAN: "Info Skorsing",
    MANAGER_CRISIS: "Situasi Pelatih",
    ROTATION_HINT: "Potensi Rotasi",
    SQUAD_BOOST: "Kabar Positif Skuad",
  };
  return map[tag] || null;
}

function humanizeMarket(key, fallbackLabel, home, away) {
  const h = home || "Team 1";
  const a = away || "Team 2";
  const map = {
    over_1_5: {
      title: "Total Over (1.5)",
      explain: "Menang jika total gol pertandingan minimal 2 gol.",
    },
    over_2_0_asian: {
      title: "Total Over (2)",
      explain: "3+ gol menang penuh · tepat 2 gol refund (modal kembali).",
    },
    over_2_25: {
      title: "Asian Total Over (2.25)",
      explain: "3+ gol menang penuh · tepat 2 gol setengah modal kembali.",
    },
    over_2_5: {
      title: "Total Over (2.5)",
      explain: "Menang jika total gol kedua tim minimal 3 gol.",
    },
    over_3_5: {
      title: "Total Over (3.5)",
      explain: "Menang jika tercipta minimal 4 gol sepanjang laga.",
    },
    over_4_5: {
      title: "Total Over (4.5)",
      explain: "Menang jika tercipta minimal 5 gol (pesta gol · odds tinggi).",
    },
    under_2_5: {
      title: "Total Under (2.5)",
      explain: "Menang jika total gol maksimal 2 gol (laga ketat).",
    },
    under_2_75: {
      title: "Asian Total Under (2.75)",
      explain: "0–2 gol menang penuh · tepat 3 gol setengah modal kembali.",
    },
    under_3_0_asian: {
      title: "Total Under (3)",
      explain: "0–2 gol menang penuh · tepat 3 gol refund (modal kembali).",
    },
    under_3_5: {
      title: "Total Under (3.5)",
      explain: "Menang jika total gol tidak lebih dari 3 gol.",
    },
    btts_yes: {
      title: "BTTS Yes",
      explain: `Menang jika ${h} dan ${a} sama-sama cetak gol (Both Teams To Score).`,
    },
    btts_no: {
      title: "BTTS No",
      explain: "Menang jika minimal satu tim gagal mencetak gol.",
    },
    btts_over_2_5: {
      title: "BTTS Yes & Over (2.5)",
      explain: `Menang jika kedua tim mencetak gol dan total skor minimal 3 gol.`,
    },
    "1h_over_0_5": {
      title: "1st Half · Total Over (0.5)",
      explain: "Menang jika sudah ada minimal 1 gol di babak pertama (HT).",
    },
    "1h_over_1_5": {
      title: "1st Half · Total Over (1.5)",
      explain: "Menang jika tercipta minimal 2 gol di babak pertama.",
    },
    home_over_0_5: {
      title: `Individual Total 1 Over (0.5) · ${h}`,
      explain: `Menang selama ${h} mencetak minimal 1 gol.`,
    },
    away_over_0_5: {
      title: `Individual Total 2 Over (0.5) · ${a}`,
      explain: `Menang selama ${a} mencetak minimal 1 gol.`,
    },
    home_over_1_5: {
      title: `Individual Total 1 Over (1.5) · ${h}`,
      explain: `Menang jika ${h} mencetak minimal 2 gol (tidak peduli skor lawan).`,
    },
    away_over_1_5: {
      title: `Individual Total 2 Over (1.5) · ${a}`,
      explain: `Menang jika ${a} mencetak minimal 2 gol (tidak peduli skor lawan).`,
    },
    home_over_2_5: {
      title: `Individual Total 1 Over (2.5) · ${h}`,
      explain: `Menang jika ${h} mencetak minimal 3 gol (pesta gol tim unggulan).`,
    },
    away_over_2_5: {
      title: `Individual Total 2 Over (2.5) · ${a}`,
      explain: `Menang jika ${a} mencetak minimal 3 gol (pesta gol tim unggulan).`,
    },
    home_cs_yes: {
      title: `${h} Clean Sheet - Yes (IT2 Under 0.5)`,
      explain: `Menang jika ${a} gagal mencetak gol (0 gol).`,
    },
    away_cs_yes: {
      title: `${a} Clean Sheet - Yes (IT1 Under 0.5)`,
      explain: `Menang jika ${h} gagal mencetak gol (0 gol).`,
    },
    "1x2_home": {
      title: `W1 (${h} Win)`,
      explain: `Menang jika ${h} unggul di skor akhir waktu normal.`,
    },
    "1x2_draw": {
      title: "X (Draw)",
      explain: "Menang jika skor berakhir imbang di waktu normal.",
    },
    "1x2_away": {
      title: `W2 (${a} Win)`,
      explain: `Menang jika ${a} unggul di skor akhir waktu normal.`,
    },
    dc_1x: {
      title: `Double Chance 1X (${h})`,
      explain: `Menang jika ${h} menang atau seri (tidak kalah).`,
    },
    dc_x2: {
      title: `Double Chance 2X (${a})`,
      explain: `Menang jika ${a} menang atau seri (tidak kalah).`,
    },
    home_dnb: {
      title: `Handicap 1 (0) · ${h} DNB`,
      explain: `${h} menang = profit · jika seri = refund (modal kembali).`,
    },
    away_dnb: {
      title: `Handicap 2 (0) · ${a} DNB`,
      explain: `${a} menang = profit · jika seri = refund (modal kembali).`,
    },
    home_ah_m025: {
      title: `Asian Handicap 1 (-0.25) · ${h}`,
      explain: `${h} menang = profit penuh · seri = setengah modal kembali.`,
    },
    away_ah_p025: {
      title: `Asian Handicap 2 (+0.25) · ${a}`,
      explain: `${a} menang = profit penuh · seri = setengah profit.`,
    },
    home_ah_m1: {
      title: `Asian Handicap 1 (-1) · ${h}`,
      explain: `${h} menang ≥2 gol = profit penuh · menang tepat 1 gol = refund.`,
    },
    away_ah_m1: {
      title: `Asian Handicap 2 (-1) · ${a}`,
      explain: `${a} menang ≥2 gol = profit penuh · menang tepat 1 gol = refund.`,
    },
    home_ah_m15: {
      title: `Asian Handicap 1 (-1.5) · ${h}`,
      explain: `${h} wajib menang dengan selisih minimal 2 gol (2-0, 3-1, dll).`,
    },
    away_ah_m15: {
      title: `Asian Handicap 2 (-1.5) · ${a}`,
      explain: `${a} wajib menang dengan selisih minimal 2 gol (0-2, 1-3, dll).`,
    },
    home_ah_p1: {
      title: `Asian Handicap 1 (+1) · ${h}`,
      explain: `${h} menang/seri = profit · kalah tepat 1 gol = refund.`,
    },
    away_ah_p1: {
      title: `Asian Handicap 2 (+1) · ${a}`,
      explain: `${a} menang/seri = profit · kalah tepat 1 gol = refund.`,
    },
  };
  if (map[key]) return map[key];
  const cm = String(key || "").match(/^corners_over_(\d+)_5$/);
  if (cm) {
    const n = Number(cm[1]) + 1;
    return {
      title: `Corners · Total Over (${cm[1]}.5)`,
      explain: `Menang jika total korner kedua tim minimal ${n} korner.`,
    };
  }
  const cu = String(key || "").match(/^corners_under_(\d+)_5$/);
  if (cu) {
    return {
      title: `Corners · Total Under (${cu[1]}.5)`,
      explain: `Menang jika total korner tidak lebih dari ${cu[1]} korner.`,
    };
  }
  const ch = String(key || "").match(/^home_corners_over_(\d+)_5$/);
  if (ch) {
    const n = Number(ch[1]) + 1;
    return {
      title: `Corners · IT1 Over (${ch[1]}.5) · ${h}`,
      explain: `Menang jika ${h} meraih minimal ${n} korner.`,
    };
  }
  const ca = String(key || "").match(/^away_corners_over_(\d+)_5$/);
  if (ca) {
    const n = Number(ca[1]) + 1;
    return {
      title: `Corners · IT2 Over (${ca[1]}.5) · ${a}`,
      explain: `Menang jika ${a} meraih minimal ${n} korner.`,
    };
  }
  return { title: fallbackLabel || key, explain: "" };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const localStorage = createFileBackedStorage(MEMORY_PATH);

  // Inject API-Football key strictly at runtime from env (never persisted to memory.json!)
  const afKey = (process.env.API_FOOTBALL_KEY || "").trim();
  if (afKey) {
    localStorage.setItem("obsidian_v18_af_key", afKey);
    localStorage.setItem("obsidian_v18_af_auto", "1");
    console.log("[Obsidian V18.8 Auto-Bot] API-Football Secret active -> Auto-Fill Gaps ON");
  }

  const engineCode = loadEngineSource();
  const ctx = {
    localStorage,
    fetch: globalThis.fetch,
    console, Date, Math, Set, Map, Promise, JSON, Number, String, Array, Object, Boolean, Error, TypeError,
    Intl, parseInt, parseFloat, isNaN, encodeURIComponent, URLSearchParams,
  };
  vm.createContext(ctx);
  vm.runInContext(engineCode + "\nglobalThis.ObsidianEngine = ObsidianEngine;", ctx);
  const eng = ctx.ObsidianEngine;

  const now = new Date();
  const todayAmt = fmtDate(now, TZ_AMT);
  const scanLimit = parseInt(process.env.SCAN_LIMIT || "14", 10);
  const XI_NOTIFIED_PATH = path.join(DATA_DIR, "xi_notified.json");

  // Auto-detect mode: Full Briefing on morning/evening/manual runs, XI_SNIPER on T-60' prime-time crons
  const sched = String(process.env.GITHUB_SCHEDULE || "").trim();
  const xiSchedules = new Set(["20 11 * * *", "55 13 * * *", "35 16 * * *", "55 18 * * *"]);
  const botMode = (process.env.BOT_MODE || (xiSchedules.has(sched) ? "xi_sniper" : "full")).toLowerCase();

  console.log(`[Obsidian V18.6 Auto-Bot] Start ${todayAmt} (${fmtTime(now, TZ_AMT)} AMT / ${fmtTime(now, TZ_WIB)} WIB) · Mode=${botMode.toUpperCase()}`);

  // Helper to resolve Telegram recipients, linked Discussion Supergroups & Owner ID via Cloudflare Access Gate
  async function resolveTelegramContext() {
    let targetChatIds = (process.env.TELEGRAM_CHAT_ID || "").trim();
    let extraGroupId = (process.env.TELEGRAM_GROUP_ID || "").trim();
    let ownerId = (process.env.TELEGRAM_OWNER_ID || "").trim();
    let premiumPublisherEnabled = true;
    const gateUrl = (process.env.OBSIDIAN_GATE_URL || "").trim().replace(/\/$/, "");
    const syncSecret = (process.env.BOT_SYNC_SECRET || "").trim();
    if (gateUrl && syncSecret) {
      try {
        const subResp = await fetch(`${gateUrl}/api/subscribers`, {
          headers: { Authorization: `Bearer ${syncSecret}` },
        });
        const subJson = await subResp.json().catch(() => ({}));
        if (subResp.ok && subJson.ok) {
          if (Array.isArray(subJson.chat_ids) && subJson.chat_ids.length) {
            targetChatIds = subJson.chat_ids.join(",");
            console.log(`[Access Gate] Synced ${subJson.chat_ids.length} target(s) (${subJson.mode || "list"}) from Cloudflare KV.`);
          }
          if (subJson.group_id && !extraGroupId) extraGroupId = String(subJson.group_id).trim();
          // Always trust live KV owner_id so Emergency Owner Takeover (/auth <RECOVERY_PIN>) immediately overrides old owner
          if (subJson.owner_id) ownerId = String(subJson.owner_id).trim();
          if (typeof subJson.premium_publisher_enabled === "boolean") {
            premiumPublisherEnabled = subJson.premium_publisher_enabled;
          }
        } else {
          console.warn(`[Access Gate] Subscriber sync returned HTTP ${subResp.status}; falling back to TELEGRAM_CHAT_ID.`);
        }
      } catch (e) {
        console.warn(`[Access Gate] Subscriber sync error (${e?.message || e}); falling back to TELEGRAM_CHAT_ID.`);
      }
    }

    const list = targetChatIds.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (extraGroupId) {
      for (const gid of extraGroupId.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)) {
        if (!list.includes(gid)) list.push(gid);
      }
    }
    if (!ownerId) {
      const numHit = list.find((id) => /^\d{6,}$/.test(id));
      if (numHit) ownerId = numHit;
    }

    const tgTok = (process.env.TELEGRAM_BOT_TOKEN || "").replace(/^["']|["']$/g, "").trim();
    const chatTypeMap = {};
    const seenCanonicalIds = new Set();

    // Inspect each configured channel/group via Telegram getChat (2-pass so @enginebolachats and its linked_chat_id never duplicate!):
    // 1) Detect exact chat type (supergroup vs broadcast channel) so @enginebolachats gets full <tg-emoji> club crests!
    // 2) Auto-discover linked Discussion Supergroup (linked_chat_id) only if not already in the target list!
    if (tgTok) {
      const autoLinkGroup = String(process.env.ENABLE_LINKED_GROUP_MIRROR || "").toLowerCase() === "true";
      const initialTargets = [...list];
      const linkedCandidates = [];
      for (const cid of initialTargets) {
        if (/^\d{6,}$/.test(cid)) {
          chatTypeMap[cid] = "private";
          seenCanonicalIds.add(cid);
          continue;
        }
        try {
          const cR = await fetch(`https://api.telegram.org/bot${tgTok}/getChat?chat_id=${encodeURIComponent(cid)}`);
          const cJ = await cR.json().catch(() => ({}));
          if (cR.ok && cJ.ok && cJ.result) {
            const cType = cJ.result.type || "";
            const canonicalId = cJ.result.id != null ? String(cJ.result.id) : "";
            chatTypeMap[cid] = cType;
            if (canonicalId) {
              chatTypeMap[canonicalId] = cType;
              seenCanonicalIds.add(canonicalId);
            }
            const linkedId = cJ.result.linked_chat_id != null ? String(cJ.result.linked_chat_id) : "";
            if (autoLinkGroup && cType === "channel" && linkedId) {
              linkedCandidates.push(linkedId);
            }
          }
        } catch {}
      }
      for (const linkedId of linkedCandidates) {
        if (!list.includes(linkedId) && !seenCanonicalIds.has(linkedId)) {
          list.push(linkedId);
          chatTypeMap[linkedId] = "supergroup";
          seenCanonicalIds.add(linkedId);
          console.log(`[Linked Supergroup] Auto-detected discussion group (${linkedId}) — will post FULL Premium club crests directly to group!`);
        }
      }
    }

    // Auto-mirror to Owner DM so Owner receives full Premium <tg-emoji> club crests & league logos (Bot API 9.4+)
    if (ownerId && String(process.env.DISABLE_OWNER_DM_MIRROR || "").toLowerCase() !== "true") {
      if (!list.includes(ownerId)) {
        list.push(ownerId);
        chatTypeMap[ownerId] = "private";
        console.log("[Owner DM Mirror] Enabled full Premium custom-emoji copy to Owner DM alongside channel/group.");
      }
    }

    let botUsername = (process.env.TELEGRAM_BOT_USERNAME || "").trim();
    if (tgTok && !botUsername) {
      try {
        const meR = await fetch(`https://api.telegram.org/bot${tgTok}/getMe`);
        const meJ = await meR.json().catch(() => ({}));
        if (meR.ok && meJ.ok && meJ.result?.username) botUsername = meJ.result.username;
      } catch {}
    }
    return { targetChatIds: list.join(","), ownerId, botUsername, chatTypeMap, premiumPublisherEnabled };
  }

  // 1. Auto-settle all finished matches (server-side = no browser CORS block -> exact corners & 1H goals!)
  const beforeSettledIds = new Set(
    eng.listPredictions("ALL").filter((p) => p.status !== "PENDING").map((p) => p.id)
  );
  const settleRes = await eng.autoSettlePending();
  const newlySettled = eng
    .listPredictions("ALL")
    .filter((p) => p.status !== "PENDING" && !beforeSettledIds.has(p.id));
  console.log(`[Auto-Settle] Checked ${settleRes.checked}, newly settled: ${settleRes.settled_count}`);

  // 2. Fetch today's slate (AMT calendar)
  let slate = await eng.fetchMatchesByDate(todayAmt, true);
  let flat = (slate.leagues || []).flatMap((l) => l.matches || []);
  let activeDate = todayAmt;
  const openToday = flat.filter((m) => !m.finished && !String(m.match_id).startsWith("espn:"));
  if (openToday.length < 3) {
    const tmrwAmt = fmtDate(new Date(now.getTime() + 86400000), TZ_AMT);
    const tSlate = await eng.fetchMatchesByDate(tmrwAmt, true);
    const tFlat = (tSlate.leagues || []).flatMap((l) => l.matches || []);
    flat = [...openToday, ...tFlat.filter((m) => !m.finished)];
    activeDate = openToday.length ? `${todayAmt} + ${tmrwAmt}` : tmrwAmt;
  }

  // Resolve Telegram target, owner_id & botUsername once; load curated + auto-generated custom emoji packs
  const tgToken = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const tgCtx = await resolveTelegramContext();
  const basePack = await loadCustomEmojiPacks(tgToken);
  const emojiPack = await createDynamicBadgeEngine({
    token: tgToken,
    ownerId: tgCtx.ownerId,
    botUsername: tgCtx.botUsername,
    basePack,
  });
  const plainEmojiPack = {
    teamIcon: (_id, _name, fb) => fb,
    leagueIcon: (_id, _name, fb) => fb,
    uiIcon: (_key, fb) => fb,
  };
  console.log(`[AutoBadge] Dynamic crest auto-gen: ${emojiPack.canUpload ? `ACTIVE (@${tgCtx.botUsername}, pack #${emojiPack.cache.pack_index})` : "OFF (dry-run or missing owner_id)"} | cached teams=${Object.keys(emojiPack.cache.teams).length}, leagues=${Object.keys(emojiPack.cache.leagues).length}`);

  // ---- STAGE 2: CONFIRMED-XI SNIPER MODE (T-75' to T-10' pre-kickoff window, zero spam) ----
  if (botMode === "xi_sniper") {
    let notified = {};
    if (fs.existsSync(XI_NOTIFIED_PATH)) {
      try { notified = JSON.parse(fs.readFileSync(XI_NOTIFIED_PATH, "utf8")) || {}; } catch {}
    }
    // Prune entries older than 36h
    const cutoff = Date.now() - 36 * 3600 * 1000;
    for (const [k, ts] of Object.entries(notified)) {
      if (Number(ts) < cutoff) delete notified[k];
    }

    const soonMatches = flat
      .filter((m) => {
        if (m.finished || m.is_live || String(m.match_id).startsWith("espn:")) return false;
        if (notified[String(m.match_id)]) return false;
        const ko = m.kickoff_utc ? new Date(m.kickoff_utc).getTime() : NaN;
        if (Number.isNaN(ko)) return false;
        const minsToKo = (ko - now.getTime()) / 60000;
        return minsToKo >= 8 && minsToKo <= 88;
      })
      .sort((a, b) => (a.is_priority ? 0 : 1) - (b.is_priority ? 0 : 1))
      .slice(0, 12);

    console.log(`[XI Sniper] Checking ${soonMatches.length} fixture(s) kicking off in 8–88 mins for Official Starting XI...`);
    const confirmedAudits = [];
    for (const m of soonMatches) {
      try {
        const a = await eng.analyzeMatchById(m.match_id, { forceRefresh: true });
        if (!a || !a.xi_confirmed || a.verdict.tier_code === "TIER_4") continue;
        // Skip thin-data obscure minor leagues (e.g. non-league / Highland League) so @enginebola stays sharp
        if (!a.is_priority && Number(a.data_confidence || 0) < 68) {
          console.log(`[XI Sniper] Skipping thin-data non-priority match: ${a.home.name} vs ${a.away.name} (${a.league_name}, conf=${a.data_confidence})`);
          continue;
        }
        confirmedAudits.push(a);
        notified[String(a.match_id)] = Date.now();
      } catch {}
    }

    // Save updated memory (with Confirmed-XI updates & preserved emoji_cache)
    const backupObj = JSON.parse(eng.exportBackup());
    backupObj.synced_by = "github_actions_xi_sniper";
    backupObj.usage = eng.getUsage();
    backupObj.emoji_cache = emojiPack.cache;
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(backupObj, null, 2), "utf8");
    fs.writeFileSync(XI_NOTIFIED_PATH, JSON.stringify(notified, null, 2), "utf8");

    if (!confirmedAudits.length) {
      console.log("[XI Sniper] No new Confirmed-XI qualifying matches right now — skipping Telegram send (zero spam).");
      return;
    }

    // Auto-generate & cache 100x100 custom emoji crests for any new teams/leagues in this Confirmed-XI alert
    await emojiPack.prewarmBatch(
      confirmedAudits.map((a) => ({
        leagueId: a.league_id,
        leagueName: a.league_name,
        leagueFallback: a.league_emoji || eng.getLeagueEmoji(a.league_name, a.country_code),
        homeId: a.home.id,
        homeName: a.home.name,
        homeFallback: a.home.flag || eng.getTeamFlag(a.home.name, a.league_name, a.country_code),
        awayId: a.away.id,
        awayName: a.away.name,
        awayFallback: a.away.flag || eng.getTeamFlag(a.away.name, a.league_name, a.country_code),
      }))
    );

    const shiftedCount = confirmedAudits.filter((a) => a.xi_shift && a.xi_shift.changed).length;
    const buildXiMsg = (ep) => {
      const xiLines = [];
      xiLines.push(`${ep.uiIcon("ball", "⚽")} <b>ENGINE BOLA · UPDATE LINI PEMAIN RESMI</b>`);
      xiLines.push(`<i>${escHtml(fmtDateIndo(now))} · ${fmtTime(now, TZ_AMT)} AMT / ${fmtTime(now, TZ_WIB)} WIB</i>`);
      xiLines.push(`<i>Susunan pemain (Starting XI) resmi telah terkonfirmasi untuk ${confirmedAudits.length} pertandingan berikut${shiftedCount ? ` · ${ep.uiIcon("shift", "🔄")} <b>${shiftedCount} prediksi berubah pasca XI!</b>` : ""}:</i>`);

      confirmedAudits.forEach((a, idx) => {
        const sp = a.verdict.sniper_pick;
        const v = a.verdict;
        const cm = a.corners_model;
        const lgEm = ep.leagueIcon(a.league_id, a.league_name, a.league_emoji || eng.getLeagueEmoji(a.league_name, a.country_code));
        const hFlag = ep.teamIcon(a.home.id, a.home.name, a.home.flag || eng.getTeamFlag(a.home.name, a.league_name, a.country_code));
        const aFlag = ep.teamIcon(a.away.id, a.away.name, a.away.flag || eng.getTeamFlag(a.away.name, a.league_name, a.country_code));
        const priInfo = humanizeMarket(v.market_key, v.primary_bet, a.home.name, a.away.name);
        const spInfo = sp ? humanizeMarket(sp.key, sp.label, a.home.name, a.away.name) : null;
        const card = [
          `<b>${idx + 1}. ${hFlag} ${escHtml(a.home.name)} vs ${aFlag} ${escHtml(a.away.name)}</b>`,
          `${lgEm} ${escHtml(a.league_name)} · <code>${escHtml(fmtKickoffDual(a.kickoff_utc))}</code>`,
          `Formasi Resmi: <b>${escHtml(a.home.formation)}</b> vs <b>${escHtml(a.away.formation)}</b>`,
        ];
        if (a.xi_shift && a.xi_shift.changed && a.xi_shift.before) {
          const bInfo = humanizeMarket(a.xi_shift.before.market_key, a.xi_shift.before.market_label, a.home.name, a.away.name);
          card.push(`${ep.uiIcon("shift", "🔄")} <b>PERUBAHAN PASCA XI RESMI:</b>`);
          card.push(`   • Sebelum (Pre-XI): <s>${escHtml(bInfo.title)}</s> (${Math.round(a.xi_shift.before.model_prob)}%)`);
          card.push(`   • Sekarang (Resmi XI): <b>${escHtml(priInfo.title)}</b> (${Math.round(a.xi_shift.after.model_prob)}%)`);
          card.push(`   • <b>Kenapa:</b> <i>${escHtml(a.xi_shift.why)}</i>`);
          card.push(`   • <b>Arah:</b> <i>${escHtml(a.xi_shift.how)}</i>`);
        } else if (a.xi_shift && a.xi_shift.significant) {
          const d = a.xi_shift.prob_delta;
          card.push(`${ep.uiIcon("chart", "📊")} <b>PERGESERAN PELUANG PASCA XI (${d >= 0 ? "+" : ""}${d}%):</b> <i>${escHtml(a.xi_shift.why)}</i>`);
        }
        if (sp && spInfo) {
          card.push(`▸ 🛡️ <b>Pilihan Aman: ${escHtml(spInfo.title)}</b> (<b>${Math.round(sp.model_prob)}%</b>)`);
          if (spInfo.explain) card.push(`   <i>${escHtml(spInfo.explain)}</i>`);
        }
        const priceNote = v.bookmaker_odds
          ? ` · Odds <b>${v.bookmaker_odds}</b>`
          : ` · Fair Odds <b>${v.fair_odds}</b>`;
        card.push(`▸ <b>Pilihan Utama: ${escHtml(priInfo.title)}</b> (<b>${Math.round(v.model_prob)}%</b>${priceNote})`);
        if (priInfo.explain && (!sp || sp.key !== v.market_key)) {
          card.push(`   <i>${escHtml(priInfo.explain)}</i>`);
        }
        if (v.value_booster) {
          const vbInfo = humanizeMarket(v.value_booster.key, v.value_booster.label, a.home.name, a.away.name);
          card.push(`▸ 🚀 <b>Value Booster (+EV): ${escHtml(vbInfo.title)}</b> (<b>${Math.round(v.value_booster.model_prob)}%</b> · Fair <b>${v.value_booster.fair_odds}x</b> · ${v.value_booster.booster_stake}u)`);
        }
        card.push(`▸ Porsi Modal: <b>${escHtml(stakeDescriptor(v.stake_units))}</b> · Est. <b>~${a.goal_model.total_lambda.toFixed(1)} gol</b>`);
        if (cm.high_volume_10_15) {
          const cParts = [`Total Over (10.5) <b>${Math.round(cm.p_over_10_5)}%</b>`, `Over (11.5) <b>${Math.round(cm.p_over_11_5)}%</b>`, `Over (12.5) <b>${Math.round(cm.p_over_12_5)}%</b>`];
          if (cm.p_over_13_5 >= 35) cParts.push(`Over (13.5) <b>${Math.round(cm.p_over_13_5)}%</b>`);
          card.push(`▸ ${ep.uiIcon("corner", "🚩")} Corners (~${Math.round(cm.total_corners_lambda)} est.): ${cParts.join(" · ")}`);
        }
        xiLines.push("");
        xiLines.push(`<blockquote>${card.join("\n")}</blockquote>`);
      });

      xiLines.push("");
      xiLines.push(`<i>Seluruh analisis di atas telah memperhitungkan daftar pemain starter resmi &amp; otomatis menandai jika prediksi berubah dari Pre-XI.</i>`);
      return xiLines.join("\n");
    };

    const richMsg = buildXiMsg(emojiPack);
    const channelMsg = buildXiMsg(plainEmojiPack);
    try { fs.writeFileSync(path.join(DATA_DIR, "last_report.txt"), richMsg); } catch {}
    try {
      const tgRes = await sendTelegram(tgToken, tgCtx.targetChatIds, richMsg, channelMsg, tgCtx.chatTypeMap, {
        ownerId: tgCtx.ownerId,
        premiumPublisherEnabled: tgCtx.premiumPublisherEnabled,
      });
      console.log("[Telegram XI Sniper]", tgRes);
    } catch (e) {
      console.warn(`::warning title=Telegram XI Sniper not delivered::${e?.message || e}`);
    }
    return;
  }

  // ---- STAGE 1: FULL BRIEFING MODE ----
  console.log(`[Daily Scanner] Scanning up to ${scanLimit} priority fixtures from ${flat.length} matches (${activeDate})...`);
  const scanRes = await eng.scanDailyTopPicks(flat, scanLimit);
  const analytics = eng.getAnalytics();

  // 3. Persist memory.json (NO secrets!) & daily_picks.json for Browser Auto-Sync
  const backupObj = JSON.parse(eng.exportBackup());
  backupObj.synced_by = "github_actions_auto_bot";
  backupObj.usage = eng.getUsage();
  backupObj.emoji_cache = emojiPack.cache;
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(backupObj, null, 2), "utf8");

  const compactPick = (a, m) => ({
    match_id: a.match_id,
    league_id: a.league_id || "",
    league: a.league_name,
    league_emoji: a.league_emoji || eng.getLeagueEmoji(a.league_name, a.country_code),
    country_code: a.country_code || "",
    home_id: a.home.id || "",
    home: a.home.name,
    home_flag: a.home.flag || eng.getTeamFlag(a.home.name, a.league_name, a.country_code),
    away_id: a.away.id || "",
    away: a.away.name,
    away_flag: a.away.flag || eng.getTeamFlag(a.away.name, a.league_name, a.country_code),
    kickoff_utc: a.kickoff_utc,
    kickoff_dual: fmtKickoffDual(a.kickoff_utc),
    xi_confirmed: a.xi_confirmed,
    xi_shift: a.xi_shift || null,
    market_key: m.key,
    market: m.label,
    model_prob: m.model_prob,
    fair_odds: m.fair_odds,
    bookmaker_odds: m.bookmaker_odds,
    edge_pct: m.edge_pct,
    push_prob: m.push_prob || 0,
    tier: a.verdict.tier,
    tier_code: a.verdict.tier_code,
    stake_units: a.verdict.stake_units,
    projected_score: a.goal_model.projected_score,
    total_lambda: a.goal_model.total_lambda,
    value_booster: a.verdict.value_booster ? {
      key: a.verdict.value_booster.key,
      label: a.verdict.value_booster.label,
      strategy_label: a.verdict.value_booster.strategy_label,
      model_prob: a.verdict.value_booster.model_prob,
      fair_odds: a.verdict.value_booster.fair_odds,
      min_ev_odds: a.verdict.value_booster.min_ev_odds,
      booster_stake: a.verdict.value_booster.booster_stake,
    } : null,
  });

  const sniperPicks = (scanRes.sniper_anchors || []).slice(0, 3).map(({ analysis, market }) => compactPick(analysis, market));
  const topAnchors = (scanRes.anchors || []).slice(0, 3).map((a) => {
    const m = a.all_markets.find((x) => x.key === a.verdict.market_key) || a.radar[0];
    return compactPick(a, m);
  });
  const topBoosters = (scanRes.value_boosters || []).slice(0, 3).map(({ analysis, market }) => ({
    ...compactPick(analysis, market),
    strategy_label: market.strategy_label || "Value Booster",
    min_ev_odds: market.min_ev_odds,
    booster_stake: market.booster_stake,
  }));
  const highCorners1015 = (scanRes.high_corners_10_15 || []).slice(0, 3).map((c) => ({
    match_id: c.analysis.match_id,
    league_id: c.analysis.league_id || "",
    league: c.analysis.league_name,
    league_emoji: c.analysis.league_emoji || eng.getLeagueEmoji(c.analysis.league_name, c.analysis.country_code),
    home_id: c.analysis.home.id || "",
    home: c.analysis.home.name,
    home_flag: c.analysis.home.flag || eng.getTeamFlag(c.analysis.home.name, c.analysis.league_name, c.analysis.country_code),
    away_id: c.analysis.away.id || "",
    away: c.analysis.away.name,
    away_flag: c.analysis.away.flag || eng.getTeamFlag(c.analysis.away.name, c.analysis.league_name, c.analysis.country_code),
    kickoff_dual: fmtKickoffDual(c.analysis.kickoff_utc),
    total_corners_lambda: c.total_corners_lambda,
    market: c.market?.label || "Corners · Total Over (10.5)",
    model_prob: c.market?.model_prob ?? c.p_over_10_5,
    p_over_10_5: c.p_over_10_5,
    p_over_11_5: c.p_over_11_5,
    p_over_12_5: c.p_over_12_5,
    p_over_13_5: c.p_over_13_5,
    p_over_14_5: c.p_over_14_5,
  }));
  const topCorners = (scanRes.best_corners || []).slice(0, 3).map(({ analysis, market }) => compactPick(analysis, market));
  const topGoals = (scanRes.best_goals || []).slice(0, 3).map(({ analysis, market }) => compactPick(analysis, market));
  const topBtts = (scanRes.best_btts || []).slice(0, 2).map(({ analysis, market }) => compactPick(analysis, market));
  const autoParlay3 = (scanRes.analyses && scanRes.analyses.length >= 3 && eng.buildAutoParlay)
    ? eng.buildAutoParlay(scanRes.analyses, { legs: 3, mode: "SAFE" })
    : null;

  // 2b. NewsAPI.org Pre-Match Intelligence (server-side = zero CORS block, max 6 calls/run to stay well under 100/day!)
  const newsApiKey = (process.env.NEWS_API_KEY || "").trim();
  const newsByMatch = {};
  let newsCalls = 0;
  if (newsApiKey && topAnchors.length) {
    console.log(`[NewsAPI] Scanning pre-match breaking news for top ${topAnchors.length} picks...`);
    for (const pick of topAnchors) {
      const intel = await fetchNewsIntelForMatch(pick.home, pick.away, newsApiKey);
      newsCalls++;
      if (intel && intel.headlines.length) {
        newsByMatch[String(pick.match_id)] = intel;
        pick.news_risk_level = intel.risk_level;
        pick.news_signals = intel.signals;
        pick.news_headline = intel.headlines[0].title;
        const predRow = (backupObj.predictions || []).find(
          (p) => String(p.match_id) === String(pick.match_id) && p.source_type === "AUTO"
        );
        if (predRow && predRow.factors) {
          predRow.factors.news_risk_level = intel.risk_level;
          predRow.factors.news_alerts = intel.signals;
        }
      }
    }
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(backupObj, null, 2), "utf8");
    fs.writeFileSync(
      NEWS_PATH,
      JSON.stringify({ generated_at: now.toISOString(), calls_used: newsCalls, by_match: newsByMatch }, null, 2),
      "utf8"
    );
    console.log(`[NewsAPI] Completed ${newsCalls} queries, found breaking intel on ${Object.keys(newsByMatch).length} matches.`);
  } else {
    if (!fs.existsSync(NEWS_PATH)) {
      fs.writeFileSync(NEWS_PATH, JSON.stringify({ generated_at: now.toISOString(), calls_used: 0, by_match: {} }, null, 2), "utf8");
    }
  }

  fs.writeFileSync(
    PICKS_PATH,
    JSON.stringify({
      generated_at: now.toISOString(),
      date_label: activeDate,
      scanned: scanRes.scanned,
      sniper_picks: sniperPicks,
      value_boosters: topBoosters,
      top_anchors: topAnchors,
      high_corners_10_15: highCorners1015,
      top_corners: topCorners,
      top_goals: topGoals,
      top_btts: topBtts,
    }, null, 2),
    "utf8"
  );

  // 3b. Auto-generate & cache 100x100 custom emoji crests for any new teams/leagues in today's report
  const toPrewarm = [
    ...sniperPicks,
    ...topAnchors,
    ...topBoosters,
    ...(highCorners1015.length ? highCorners1015 : topCorners),
    ...topBtts,
    ...(autoParlay3?.legs || []),
  ].map((x) => ({
    leagueId: x.league_id,
    leagueName: x.league,
    leagueFallback: x.league_emoji,
    homeId: x.home_id,
    homeName: x.home,
    homeFallback: x.home_flag,
    awayId: x.away_id,
    awayName: x.away,
    awayFallback: x.away_flag,
  }));
  await emojiPack.prewarmBatch(toPrewarm);

  // 4. Build sleek, editorial, beginner-friendly Telegram HTML brief (rich custom-emoji crests for DM/Groups + full Unicode flags for @channel)
  const buildDailyMsg = (ep) => {
    const lines = [];
    lines.push(`${ep.uiIcon("ball", "⚽")} <b>ENGINE BOLA · DAILY RADAR</b>`);
    lines.push(`<i>${escHtml(fmtDateIndo(now))} · ${fmtTime(now, TZ_AMT)} AMT / ${fmtTime(now, TZ_WIB)} WIB</i>`);

    // Compact executive recap (never clutters the channel with verbose debug logs)
    const s = analytics.summary;
    if (newlySettled.length > 0) {
      const nw = newlySettled.filter((p) => p.status === "WON" || p.status === "HALF_WON").length;
      const nl = newlySettled.filter((p) => p.status === "LOST" || p.status === "HALF_LOST").length;
      const np = newlySettled.filter((p) => p.status === "PUSH").length;
      const rec = [
        `${ep.uiIcon("chart", "📊")} <b>REKAP HASIL SEMALAM (${newlySettled.length} Laga)</b>`,
        `Menang <b>${nw}</b> · Seri/Refund <b>${np}</b> · Kalah <b>${nl}</b>`,
        `<i>Model otomatis mengevaluasi hasil &amp; memperbarui kalibrasi. Rincian lengkap 5W1H tersedia di VIP Dashboard.</i>`,
      ];
      lines.push("");
      lines.push(`<blockquote>${rec.join("\n")}</blockquote>`);
    } else if (s.settled > 0) {
      lines.push("");
      lines.push(`<blockquote>${ep.uiIcon("chart", "📊")} <b>REKAM JEJAK MODEL</b>\nAkurasi: <b>${s.hit_rate}%</b> (${s.wins} Menang · ${s.pushes} Seri · ${s.losses} Kalah)</blockquote>`);
    }

    // Helper to render one clean editorial match card (Dual-Track: Safe Pick + Value Booster!)
    const renderPickCard = (p, idx, isSniper = false) => {
      const info = humanizeMarket(p.market_key, p.market, p.home, p.away);
      const lgEm = ep.leagueIcon(p.league_id, p.league, p.league_emoji || eng.getLeagueEmoji(p.league, p.country_code));
      const hFlag = ep.teamIcon(p.home_id, p.home, p.home_flag || eng.getTeamFlag(p.home, p.league, p.country_code));
      const aFlag = ep.teamIcon(p.away_id, p.away, p.away_flag || eng.getTeamFlag(p.away, p.league, p.country_code));
      const xiLine = p.xi_confirmed
        ? `Susunan Pemain: <b>Resmi Terkonfirmasi ✓</b>`
        : `Susunan Pemain: <i>Menunggu rilis resmi (T-60' sebelum kickoff)</i>`;
      const priceBit = p.bookmaker_odds
        ? ` · Odds <b>${p.bookmaker_odds}</b>`
        : ` · Fair Odds <b>${p.fair_odds}</b>`;
      const card = [
        `<b>${idx + 1}. ${hFlag} ${escHtml(p.home)} vs ${aFlag} ${escHtml(p.away)}</b>`,
        `${lgEm} ${escHtml(p.league)} · <code>${escHtml(p.kickoff_dual)}</code>`,
        `▸ 🛡️ Safe Pick: <b>${escHtml(info.title)}</b> (<b>${Math.round(p.model_prob)}%</b>${priceBit}${isSniper ? "" : ` · ${escHtml(stakeDescriptor(p.stake_units))}`})`,
      ];
      if (p.value_booster && p.value_booster.key !== p.market_key) {
        const vbInfo = humanizeMarket(p.value_booster.key, p.value_booster.label, p.home, p.away);
        card.push(`▸ 🚀 Value Booster: <b>${escHtml(vbInfo.title)}</b> (<b>${Math.round(p.value_booster.model_prob)}%</b> · Fair <b>${p.value_booster.fair_odds}x</b> · ${p.value_booster.booster_stake}u)`);
      }
      if (p.xi_shift && p.xi_shift.changed && p.xi_shift.before) {
        const bInfo = humanizeMarket(p.xi_shift.before.market_key, p.xi_shift.before.market_label, p.home, p.away);
        card.push(`▸ ${ep.uiIcon("shift", "🔄")} <b>XI Shift:</b> <s>${escHtml(bInfo.title)}</s> → <b>${escHtml(info.title)}</b> (<i>${escHtml(p.xi_shift.why)}</i>)`);
      }
      if (info.explain) {
        card.push(`▸ Arti Singkat: <i>${escHtml(info.explain)}</i>`);
      }
      card.push(`▸ Estimasi Tempo: <b>~${Number(p.total_lambda || 2.5).toFixed(1)} gol</b> · ${xiLine}`);
      const sigTag = (p.news_signals || []).map(newsTagIndo).find(Boolean);
      if (sigTag && p.news_headline) {
        card.push(`▸ ${escHtml(sigTag)}: <i>${escHtml(p.news_headline.slice(0, 95))}</i>`);
      }
      return `<blockquote>${card.join("\n")}</blockquote>`;
    };

    if (sniperPicks.length) {
      lines.push("");
      lines.push(`${ep.uiIcon("target", "🎯")} <b>PILIHAN SAFE · AKURASI TINGGI</b>`);
      lines.push(`<i>Seleksi paling ketat — fokus peluang tertinggi &amp; proteksi modal.</i>`);
      sniperPicks.forEach((p, idx) => {
        lines.push("");
        lines.push(renderPickCard(p, idx, true));
      });
    }

    lines.push("");
    lines.push(`${ep.uiIcon("radar", "📡")} <b>ANALISIS PILIHAN HARI INI (SAFE + VALUE)</b>`);
    lines.push(`<i>Disaring dari ${scanRes.scanned} pertandingan prioritas hari ini.</i>`);
    if (!topAnchors.length) {
      lines.push("");
      lines.push(`<blockquote><i>Belum ada pertandingan yang memenuhi standar seleksi ketat saat ini.</i></blockquote>`);
    } else {
      topAnchors.forEach((p, idx) => {
        lines.push("");
        lines.push(renderPickCard(p, idx, false));
      });
    }

    // Dedicated High-Value Boosters block (Over 3.5 / Over 4.5 / AH -1.5 / Team O1.5) — only when within 1-message limit
    if (topBoosters.length) {
      const vbRows = topBoosters.map((b, i) => {
        const info = humanizeMarket(b.market_key, b.market, b.home, b.away);
        const hf = ep.teamIcon(b.home_id, b.home, b.home_flag);
        const af = ep.teamIcon(b.away_id, b.away, b.away_flag);
        const lg = ep.leagueIcon(b.league_id, b.league, b.league_emoji);
        return `${i + 1}. ${hf} <b>${escHtml(b.home)} vs ${af} ${escHtml(b.away)}</b> (${lg} ${escHtml(b.league)})\n   ▸ <b>${escHtml(info.title)}</b> (<b>${Math.round(b.model_prob)}%</b> · Fair <b>${b.fair_odds}x</b> · Min +EV ${b.min_ev_odds})`;
      });
      const vbBlock = [
        ``,
        `🚀 <b>HIGH-VALUE BOOSTERS (+EV · OVER 3.5 / 4.5 / AH -1.5)</b>`,
        `<blockquote>${vbRows.join("\n")}</blockquote>`,
      ].join("\n");
      if ((visibleTextLen(lines.join("\n")) + visibleTextLen(vbBlock) + 260) < 3850) {
        lines.push(vbBlock);
      }
    }

    if (highCorners1015.length) {
      lines.push("");
      lines.push(`${ep.uiIcon("corner", "🚩")} <b>RADAR CORNERS TINGGI (10–15+ CORNERS)</b>`);
      lines.push(`<i>Laga dengan intensitas serangan sayap &amp; potensi tendangan sudut tinggi.</i>`);
      const cRows = highCorners1015.map((c) => {
        const tiers = [
          `Total Over (10.5) <b>${Math.round(c.p_over_10_5)}%</b>`,
          `Over (11.5) <b>${Math.round(c.p_over_11_5)}%</b>`,
          `Over (12.5) <b>${Math.round(c.p_over_12_5)}%</b>`,
        ];
        if (c.p_over_13_5 >= 35) tiers.push(`Over (13.5) <b>${Math.round(c.p_over_13_5)}%</b>`);
        if (c.p_over_14_5 >= 30) tiers.push(`Over (14.5) <b>${Math.round(c.p_over_14_5)}%</b>`);
        const hf = ep.teamIcon(c.home_id, c.home, c.home_flag);
        const af = ep.teamIcon(c.away_id, c.away, c.away_flag);
        const lg = ep.leagueIcon(c.league_id, c.league, c.league_emoji);
        return `${hf} <b>${escHtml(c.home)} vs ${af} ${escHtml(c.away)}</b> · ${lg} <i>${escHtml(c.league)}</i>\nEst. <b>~${Math.round(c.total_corners_lambda)} corners</b> → ${tiers.join(" · ")}`;
      });
      lines.push("");
      lines.push(`<blockquote>${cRows.join("\n—\n")}</blockquote>`);
    } else if (topCorners.length) {
      lines.push("");
      lines.push(`${ep.uiIcon("corner", "🚩")} <b>PILIHAN CORNERS TERBAIK</b>`);
      const cRows = topCorners.map((c) => {
        const info = humanizeMarket(c.market_key, c.market, c.home, c.away);
        const hf = ep.teamIcon(c.home_id, c.home, c.home_flag);
        const af = ep.teamIcon(c.away_id, c.away, c.away_flag);
        const lg = ep.leagueIcon(c.league_id, c.league, c.league_emoji);
        return `• ${hf} <b>${escHtml(c.home)} vs ${af} ${escHtml(c.away)}</b> (${lg} ${escHtml(c.league)}) — <b>${escHtml(info.title)}</b> (<b>${Math.round(c.model_prob)}%</b>)`;
      });
      lines.push("");
      lines.push(`<blockquote>${cRows.join("\n")}</blockquote>`);
    }

    if (topBtts.length) {
      const bRows = topBtts.map((b) => {
        const info = humanizeMarket(b.market_key, b.market, b.home, b.away);
        const hf = ep.teamIcon(b.home_id, b.home, b.home_flag);
        const af = ep.teamIcon(b.away_id, b.away, b.away_flag);
        const lg = ep.leagueIcon(b.league_id, b.league, b.league_emoji);
        return `• ${hf} <b>${escHtml(b.home)} vs ${af} ${escHtml(b.away)}</b> (${lg} ${escHtml(b.league)}) — <b>${escHtml(info.title)}</b> (<b>${Math.round(b.model_prob)}%</b>)`;
      });
      const bttsBlock = [
        ``,
        `${ep.uiIcon("fire", "🔥")} <b>BOTH TEAMS TO SCORE (BTTS)</b>`,
        `<blockquote>${bRows.join("\n")}</blockquote>`,
      ].join("\n");
      if ((visibleTextLen(lines.join("\n")) + visibleTextLen(bttsBlock) + 220) < 3850) {
        lines.push(bttsBlock);
      }
    }

    // Append compact 3-Leg Auto-Parlay Safe only if final visible message remains under 3850 chars (1 single Telegram message!)
    if (autoParlay3 && autoParlay3.legs && autoParlay3.legs.length >= 3) {
      const pRows = autoParlay3.legs.map((l) => {
        const info = humanizeMarket(l.market.key, l.market.label, l.home, l.away);
        const hf = ep.teamIcon(l.home_id, l.home, l.home_flag);
        const af = ep.teamIcon(l.away_id, l.away, l.away_flag);
        const lg = ep.leagueIcon(l.league_id, l.league, l.league_emoji);
        return `${l.index}. ${hf} <b>${escHtml(l.home)} vs ${af} ${escHtml(l.away)}</b> (${lg} ${escHtml(l.league)})\n   ▸ <b>${escHtml(info.title)}</b> (${Math.round(l.market.model_prob)}% · ${l.used_odds}x)`;
      });
      const parlayBlock = [
        ``,
        `${ep.uiIcon("ticket", "🎟️")} <b>AUTO-PARLAY 3-LEG SAFE</b> · Total <b>${autoParlay3.combined_odds.toFixed(2)}x</b> (Win <b>${autoParlay3.combined_win_prob}%</b>)`,
        `<blockquote>${pRows.join("\n")}</blockquote>`,
      ].join("\n");
      if ((visibleTextLen(lines.join("\n")) + visibleTextLen(parlayBlock) + 220) < 3850) {
        lines.push(parlayBlock);
      }
    }

    lines.push("");
    lines.push(`<i>Catatan: Analisis bertanda "Menunggu rilis resmi" belum menyertakan daftar pemain starter. Update otomatis dikirim 1 jam sebelum kickoff saat Starting XI resmi keluar — termasuk penanda ${ep.uiIcon("shift", "🔄")} jika prediksi berubah.</i>`);
    return lines.join("\n");
  };

  // Technical calibration metrics stay in stdout logs (not cluttering public channel)
  const fp = analytics.weights.factor_penalties || {};
  console.log(`[Neural Metrics] Goal×${analytics.weights.goal_lambda_scale} · Corner×${analytics.weights.corner_lambda_scale} · Pre-XI -${fp.pre_xi || 0} · AF ${backupObj.usage.api_football}/100 · News ${newsCalls}q`);

  const richMsg = buildDailyMsg(emojiPack);
  const channelMsg = buildDailyMsg(plainEmojiPack);
  try { fs.writeFileSync(path.join(DATA_DIR, "last_report.txt"), richMsg); } catch {}

  let tgRes;
  try {
    tgRes = await sendTelegram(
      tgToken,
      tgCtx.targetChatIds,
      richMsg,
      channelMsg,
      tgCtx.chatTypeMap,
      {
        ownerId: tgCtx.ownerId,
        premiumPublisherEnabled: tgCtx.premiumPublisherEnabled,
      }
    );
  } catch (e) {
    tgRes = { ok: false, error: String(e?.message || e) };
    console.warn(`::warning title=Telegram not delivered::${tgRes.error}`);
  }
  console.log("[Telegram]", tgRes);
  console.log("[Done] Saved data/memory.json, data/daily_picks.json, data/news_intel.json & data/last_report.txt");
}

main().catch((err) => {
  console.error("[Obsidian Auto-Bot ERROR]", err);
  process.exit(1);
});
