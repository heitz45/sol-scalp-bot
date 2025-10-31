// bot.js — Pump.fun-enabled thin-liquidity SCALP bot for Solana
// Features: Auth, whoami/authstatus, sharded TP/SL monitor,
// Autopilot (PumpPortal websocket signals), micro TF (15s/30s/1m/5m),
// Trades via PumpPortal bonding curve with Jupiter fallback after migration.
// Requires: npm i ws node-fetch telegraf bs58 @solana/web3.js dotenv

import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import WebSocket from 'ws';
import { Telegraf } from 'telegraf';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction
} from '@solana/web3.js';

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['1.1.1.1', '8.8.8.8']); // Cloudflare + Google DNS

// -------------------- ENV --------------------
const {
  RPC_URL = 'https://api.mainnet-beta.solana.com',
  WALLET_PRIVATE_KEY_BASE58,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ALLOWED_USER_ID = '',
  TELEGRAM_ALLOWED_CHAT_ID = '',
  DEBUG_IDS = 'false',

  MAX_SLIPPAGE_BPS = '300',
  DEFAULT_BUY_SOL = '0.05',
  POLL_SECONDS = '10',

  // Autopilot defaults (persisted to autopilot.json on first run)
  AUTOPILOT_ENABLED = 'false',
  AUTOPILOT_BUDGET_SOL_PER_BUY = '0.02',
  AUTOPILOT_MAX_OPEN_POSITIONS = '3',
  // Dex liquidity/volume filters don't exist pre-migration; we use momentum gates instead.
  AUTOPILOT_MIN_5M_BUY_TX = '20',
  AUTOPILOT_MIN_5M_PRICE_CHANGE_PCT = '4',
  AUTOPILOT_COOLDOWN_MIN = '30',
  AUTOPILOT_BLACKLIST = '',

  // Short-timeframe momentum
  AUTOPILOT_MIN_1M_PRICE_CHANGE_PCT = '2',
  AUTOPILOT_MIN_1M_BUY_TX = '6',
  AUTOPILOT_MOMO_WEIGHT = '1.8',

  // NEW: sub-minute gates
  AUTOPILOT_MIN_30S_PRICE_CHANGE_PCT = '0.9',
  AUTOPILOT_MIN_30S_BUY_TX = '4',
  AUTOPILOT_MIN_15S_PRICE_CHANGE_PCT = '0.6',
  AUTOPILOT_MIN_15S_BUY_TX = '3',

  PARTIAL_TP_ENABLED = 'false',

  // Jupiter proxy (unchanged)
  JUPITER_BASE = 'https://quote-api.jup.ag/v6',

  // PumpPortal realtime + trade
  PUMPPORTAL_WSS = 'wss://pumpportal.fun/api/data',
  PUMPPORTAL_API_KEY = '',
  USE_PUMPPORTAL_TRADE = 'true',
  PUMPPORTAL_DEFAULT_SLIPPAGE = '10',     // percent
  PUMPPORTAL_PRIORITY_FEE = '0.00005'     // SOL
} = process.env;

// -------------------- GUARDS --------------------
if (!WALLET_PRIVATE_KEY_BASE58) { console.error('Missing WALLET_PRIVATE_KEY_BASE58'); process.exit(1); }
if (!TELEGRAM_BOT_TOKEN) { console.error('Missing TELEGRAM_BOT_TOKEN'); process.exit(1); }

// -------------------- AUTH --------------------
const USER_ALLOWLIST = TELEGRAM_ALLOWED_USER_ID.split(',').map(s => s.trim()).filter(Boolean);
const CHAT_ALLOWLIST = TELEGRAM_ALLOWED_CHAT_ID.split(',').map(s => s.trim()).filter(Boolean);
function allowed(ctx) {
  const fromId = String(ctx.from?.id || '');
  const chatId = String(ctx.chat?.id || '');
  const userOk = USER_ALLOWLIST.includes(fromId);
  const chatOk = CHAT_ALLOWLIST.includes(chatId);
  return userOk || chatOk;
}
function authGuard(handler) {
  return (ctx) => {
    if (!allowed(ctx)) return ctx.reply('Not authorized.');
    return handler(ctx);
  };
}

// -------------------- KEYPAIR --------------------
let keypair;
try {
  const secretBytes = bs58.decode(WALLET_PRIVATE_KEY_BASE58);
  keypair = Keypair.fromSecretKey(Uint8Array.from(secretBytes));
} catch {
  console.error('Failed to decode WALLET_PRIVATE_KEY_BASE58');
  process.exit(1);
}
console.log('Bot wallet public key:', keypair.publicKey.toBase58());

// -------------------- BASE SETUP --------------------
const connection = new Connection(RPC_URL, 'confirmed');
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Hard-coded SCALP triggers
const SCALP_TP_PCT = 5;   // take profit +5%
const SCALP_SL_PCT = 1.5; // stop loss -1.5%

// Thin-liquidity tuning (env-driven caps)
const THIN = {
  SLIPPAGE_BASE: Number(process.env.THIN_MAX_SLIPPAGE_BPS_BASE || '200'),
  SLIPPAGE_CAP: Number(process.env.THIN_MAX_SLIPPAGE_BPS_CAP || '500'),
  TARGET_IMPACT: Number(process.env.THIN_TARGET_IMPACT_PCT || '2.0'),
  HARD_IMPACT: Number(process.env.THIN_HARD_IMPACT_PCT || '5.0'),
  MAX_SHARDS: Number(process.env.THIN_MAX_SHARDS || '5'),
  MIN_SHARD_SOL: Number(process.env.THIN_MIN_SHARD_SOL || '0.005'),
  SHARD_DELAY_MS: Number(process.env.THIN_SHARD_DELAY_MS || '800'),
  EXIT_SHARDS: Number(process.env.THIN_EXIT_SHARDS || '3'),
  EXIT_DELAY_MS: Number(process.env.THIN_EXIT_DELAY_MS || '1200')
};

if (String(DEBUG_IDS).toLowerCase() === 'true') {
  bot.on('message', (ctx, next) => {
    console.log('DBG from.id=', ctx.from?.id, 'chat.id=', ctx.chat?.id, 'username=@' + (ctx.from?.username || 'n/a'));
    return next();
  });
}

// -------------------- PERSISTENCE --------------------
const POSITIONS_FILE = './positions.json';
function loadPositions() {
  try { if (!fs.existsSync(POSITIONS_FILE)) return {}; return JSON.parse(fs.readFileSync(POSITIONS_FILE,'utf-8')); }
  catch { return {}; }
}
function savePositions() {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}
let positions = loadPositions(); // keyed by mint
let lastChatId = null;

// --- AUTOPILOT CONFIG (persistent file) ---
const AUTOPILOT_CFG_FILE = './autopilot.json';
const AUTOPILOT_DEFAULTS = {
  enabled: String(AUTOPILOT_ENABLED).toLowerCase() === 'true',
  budgetSol: Number(AUTOPILOT_BUDGET_SOL_PER_BUY),
  maxOpen: Number(AUTOPILOT_MAX_OPEN_POSITIONS),
  // Momentum gates only (pre-migration)
  minBuys5m: Number(AUTOPILOT_MIN_5M_BUY_TX),
  minChange5m: Number(AUTOPILOT_MIN_5M_PRICE_CHANGE_PCT),
  cooldownMs: Number(AUTOPILOT_COOLDOWN_MIN) * 60 * 1000,
  blacklist: (AUTOPILOT_BLACKLIST || '').split(',').map(s => s.trim()).filter(Boolean),
  lastBuyAt: 0,
  lastTried: {}, // mint -> ts

  // Short-term gates
  minChange1m: Number(AUTOPILOT_MIN_1M_PRICE_CHANGE_PCT),
  minBuys1m: Number(AUTOPILOT_MIN_1M_BUY_TX),
  momoWeight: Number(AUTOPILOT_MOMO_WEIGHT),

  // Sub-minute gates
  minChange30s: Number(AUTOPILOT_MIN_30S_PRICE_CHANGE_PCT),
  minBuys30s: Number(AUTOPILOT_MIN_30S_BUY_TX),
  minChange15s: Number(AUTOPILOT_MIN_15S_PRICE_CHANGE_PCT),
  minBuys15s: Number(AUTOPILOT_MIN_15S_BUY_TX)
};
function loadAutopilotCfg() {
  try {
    if (!fs.existsSync(AUTOPILOT_CFG_FILE)) return { ...AUTOPILOT_DEFAULTS };
    const raw = JSON.parse(fs.readFileSync(AUTOPILOT_CFG_FILE, 'utf-8'));
    return { ...AUTOPILOT_DEFAULTS, ...raw, lastTried: raw.lastTried || {} };
  } catch { return { ...AUTOPILOT_DEFAULTS }; }
}
function saveAutopilotCfg() { fs.writeFileSync(AUTOPILOT_CFG_FILE, JSON.stringify(AUTOPILOT, null, 2)); }
const AUTOPILOT = loadAutopilotCfg();

// -------------------- JUPITER HELPERS --------------------
const JUP_BASE = (JUPITER_BASE || '').replace(/\/$/, '');

function normalizeQuote(resp) {
  if (resp?.data?.[0]) return resp.data[0]; // Jupiter v6 format
  if (resp?.outAmount != null || resp?.inAmount != null) return resp; // Lite format
  throw new Error('Quote response missing route');
}

async function jupQuote({ inputMint, outputMint, amountRaw, slippageBps }) {
  const url = new URL(JUP_BASE + '/quote');
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amountRaw));
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('onlyDirectRoutes', 'false');

  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Quote failed (${r.status}) — ${text.slice(0,180)}`);

  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Quote JSON parse failed'); }
  return normalizeQuote(data);
}

async function jupBuildAndSend({ quoteResponse }) {
  const res = await fetch(JUP_BASE + '/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true
    })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Swap build failed (${res.status}) — ${text.slice(0,180)}`);

  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Swap JSON parse failed'); }

  const { swapTransaction } = data;
  if (!swapTransaction) throw new Error('No swapTransaction in response');

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([keypair]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
  const conf = await connection.confirmTransaction(sig, 'confirmed');
  if (conf.value.err) throw new Error(`Swap failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

// -------------------- CHAIN HELPERS --------------------
async function verifyMintExists(mint) {
  const pk = new PublicKey(mint);
  const info = await connection.getParsedAccountInfo(pk);
  if (!info?.value) throw new Error('Mint does not exist');
  return true;
}
async function getTokenRawBalance(mint) {
  const ataList = await connection.getParsedTokenAccountsByOwner(
    keypair.publicKey,
    { mint: new PublicKey(mint) }
  );
  const ata = ataList.value[0];
  if (!ata) return 0n;
  const info = ata.account.data.parsed.info;
  return BigInt(info.tokenAmount.amount);
}
async function estimateSolForToken({ mint, amountRaw }) {
  if (amountRaw <= 0n) return 0n;
  const route = await jupQuote({
    inputMint: mint,
    outputMint: WSOL_MINT,
    amountRaw: String(amountRaw),
    slippageBps: Number(MAX_SLIPPAGE_BPS)
  });
  return BigInt(route.outAmount);
}

// -------------------- PUMPPORTAL REALTIME SIGNAL ENGINE --------------------
const PUMP_WSS = PUMPPORTAL_WSS || 'wss://pumpportal.fun/api/data';
const feed = {
  // mint -> { lastPriceSol, trades: [{ts, side, priceSol, amountSol}] }
  byMint: new Map(),
  metrics(mint) {
    const now = Date.now();
    const b = this.byMint.get(mint);
    if (!b) return null;
    // Keep last 5 minutes
    b.trades = b.trades.filter(t => now - t.ts <= 5*60*1000);

    const within = (ms) => b.trades.filter(t => now - t.ts <= ms);

    const m15 = within(15*1000);
    const m30 = within(30*1000);
    const m60 = within(60*1000);
    const m300= within(5*60*1000);

    const priceNow = b.lastPriceSol ?? (m60[m60.length-1]?.priceSol ?? null);

    function pctChange(arr) {
      if (arr.length < 2) return 0;
      const first = arr[0].priceSol;
      const last  = arr[arr.length-1].priceSol;
      if (!first || !last) return 0;
      return ((last - first)/first)*100;
    }

    const buys = a => a.filter(t => t.side === 'buy').length;

    return {
      priceNowSol: priceNow,

      // Sub-minute
      buys15s: buys(m15), chg15s: pctChange(m15),
      buys30s: buys(m30), chg30s: pctChange(m30),

      // Minute & 5m
      buys1m: buys(m60), chg1m: pctChange(m60),
      buys5m: buys(m300), chg5m: pctChange(m300)
    };
  }
};

function attachPumpPortal() {
  const ws = new WebSocket(PUMP_WSS);

  ws.on('open', () => {
    // Stream new token events; we will subscribe to trades for each new mint.
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // New token created
      if (msg.message === 'newToken' && msg.mint) {
        ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [msg.mint] }));
        if (!feed.byMint.has(msg.mint)) feed.byMint.set(msg.mint, { lastPriceSol: null, trades: [] });
      }

      // Per-token trade stream
      if (msg.message === 'tokenTrade' && msg.mint) {
        const m = feed.byMint.get(msg.mint) || { lastPriceSol: null, trades: [] };
        const side = String(msg.side || '').toLowerCase();
        const priceSol = Number(msg.priceSol ?? msg.price ?? 0);
        const amountSol = Number(msg.solAmount ?? msg.amountSol ?? 0);

        if (priceSol > 0) m.lastPriceSol = priceSol;
        m.trades.push({ ts: Date.now(), side, priceSol, amountSol });
        feed.byMint.set(msg.mint, m);
      }
    } catch {}
  });

  ws.on('close', () => setTimeout(attachPumpPortal, 1500));
  ws.on('error', () => ws.close());
}
attachPumpPortal();

// -------------------- TRADING HELPERS: PumpPortal + Jupiter fallback --------------------
async function pumpportalTrade({ action, mint, amountSol, amountRawTokens }) {
  const apiKey = PUMPPORTAL_API_KEY || '';
  if (!apiKey) throw new Error('Missing PUMPPORTAL_API_KEY');

  const body = {
    action,                                 // 'buy' | 'sell'
    mint,
    slippage: Number(PUMPPORTAL_DEFAULT_SLIPPAGE || 10),
    priorityFee: Number(PUMPPORTAL_PRIORITY_FEE || 0.00005),
    pool: 'auto'
  };
  if (action === 'buy') {
    body.denominatedInSol = 'true';
    body.amount = Number(amountSol);
  } else {
    body.denominatedInSol = 'false';
    body.amount = typeof amountRawTokens === 'string' ? amountRawTokens : Number(amountRawTokens || 0);
  }

  const r = await fetch(`https://pumpportal.fun/api/trade?api-key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`PumpPortal trade failed ${r.status}: ${text.slice(0,180)}`);
  return JSON.parse(text); // contains signature/status
}

async function smartBuy({ mint, amountSol }) {
  const usePP = String(USE_PUMPPORTAL_TRADE || 'true').toLowerCase() === 'true';
  if (usePP) {
    try {
      await pumpportalTrade({ action: 'buy', mint, amountSol });
      return { route: 'pumpportal', outRaw: 0n, spentSol: Number(amountSol) };
    } catch (e) {
      console.warn('[PP buy fallback to JUP]', e.message);
    }
  }
  const lamports = Math.floor(Number(amountSol) * 1e9);
  const routeQuote = await jupQuote({
    inputMint: WSOL_MINT,
    outputMint: mint,
    amountRaw: lamports,
    slippageBps: THIN.SLIPPAGE_BASE
  });
  await jupBuildAndSend({ quoteResponse: routeQuote });
  return { route: 'jupiter', outRaw: BigInt(routeQuote.outAmount || 0), spentSol: Number(lamports)/1e9 };
}

async function smartSell({ mint, amountRaw }) {
  const usePP = String(USE_PUMPPORTAL_TRADE || 'true').toLowerCase() === 'true';
  if (usePP) {
    try {
      await pumpportalTrade({ action: 'sell', mint, amountRawTokens: String(amountRaw) });
      return { route: 'pumpportal', outLamports: 0n };
    } catch (e) {
      console.warn('[PP sell fallback to JUP]', e.message);
    }
  }
  // fallback to Jupiter shard-sell
  const totalRaw = BigInt(amountRaw);
  if (totalRaw <= 0n) throw new Error('Nothing to sell');

  const shards = Math.min(THIN.EXIT_SHARDS, Number(THIN.EXIT_SHARDS));
  let remaining = totalRaw;
  let soldLamports = 0n;

  for (let i = 0; i < shards; i++) {
    const last = (i === shards - 1);
    const slice = last ? remaining : (remaining / BigInt(shards - i));
    if (slice <= 0n) break;

    const route = await jupQuote({
      inputMint: mint,
      outputMint: WSOL_MINT,
      amountRaw: String(slice),
      slippageBps: Math.min(Number(THIN.SLIPPAGE_BASE), THIN.SLIPPAGE_CAP)
    });

    await jupBuildAndSend({ quoteResponse: route });
    soldLamports += BigInt(route.outAmount);
    remaining    -= BigInt(route.inAmount || slice);

    await new Promise(r => setTimeout(r, THIN.EXIT_DELAY_MS));
  }

  return { route: 'jupiter', outLamports: soldLamports };
}

// -------------------- BUY via JUP (legacy shards) — used by /autosim only --------------------
function extractImpactPct(route) {
  if (route?.priceImpactPct != null) return Number(route.priceImpactPct);
  return NaN;
}

// -------------------- TELEGRAM COMMANDS --------------------
bot.command('whoami', (ctx) =>
  ctx.reply(`Your user id: ${ctx.from?.id}\nChat id: ${ctx.chat?.id}\nUsername: @${ctx.from?.username || 'n/a'}`)
);

bot.command('authstatus', (ctx) => {
  const rawUsers = String(process.env.TELEGRAM_ALLOWED_USER_ID || '');
  const rawChats = String(process.env.TELEGRAM_ALLOWED_CHAT_ID || '');
  const allowUsers = rawUsers.split(',').map(s => s.trim()).filter(Boolean);
  const allowChats = rawChats.split(',').map(s => s.trim()).filter(Boolean);
  const fromId = String(ctx.from?.id || '');
  const chatId = String(ctx.chat?.id || '');
  const userOk = allowUsers.includes(fromId);
  const chatOk = allowChats.includes(chatId);
  ctx.reply(
`Auth debug:
- from.id: ${fromId}
- chat.id: ${chatId}
- TELEGRAM_ALLOWED_USER_ID: ${rawUsers || '(empty)'}
- TELEGRAM_ALLOWED_CHAT_ID: ${rawChats || '(empty)'}
- userOk: ${userOk}  chatOk: ${chatOk}
- allowed(): ${userOk || chatOk ? 'YES' : 'NO'}`
  );
});

bot.start(authGuard((ctx) => {
  lastChatId = ctx.chat?.id || lastChatId;
  ctx.reply(
`Ready. Commands:
/whoami
/authstatus
/bal
/buy <mint> [sol]
/sell <mint> [percent]
/autobuy <mint> [sol]
/status
/cancel <mint>
/autopilot on|off|status
/autofilters
/scan
/autosim <mint> [sol]

Autopilot: ${AUTOPILOT.enabled ? 'ON' : 'OFF'}
Wallet: ${keypair.publicKey.toBase58()}`
  );
}));

bot.on('message', (ctx, next) => {
  if (allowed(ctx)) lastChatId = ctx.chat?.id || lastChatId;
  return next();
});

bot.command('bal', authGuard(async (ctx) => {
  const bal = await connection.getBalance(keypair.publicKey);
  ctx.reply(`SOL: ${(bal/1e9).toFixed(4)} — ${keypair.publicKey.toBase58()}`);
}));

bot.command('buy', authGuard(async (ctx) => {
  const [, mint, solStr] = ctx.message.text.trim().split(/\s+/);
  const amountSol = solStr ?? DEFAULT_BUY_SOL;
  if (!mint) return ctx.reply('Usage: /buy <mint> [sol]');
  const sol = Number(amountSol);
  if (isNaN(sol) || sol <= 0) return ctx.reply('Invalid SOL amount.');
  try {
    await verifyMintExists(mint);
    const res = await smartBuy({ mint, amountSol: sol });
    ctx.reply(`Bought ~${res.spentSol.toFixed(6)} SOL of ${mint}\nRoute: ${res.route}`);
  } catch (e) { ctx.reply(`Buy failed: ${e.message}`); }
}));

bot.command('sell', authGuard(async (ctx) => {
  const [, mint, pctStr] = ctx.message.text.trim().split(/\s+/);
  const pct = Number(pctStr ?? '100');
  if (!mint || isNaN(pct) || pct <= 0 || pct > 100) return ctx.reply('Usage: /sell <mint> [percent 1-100]');
  try {
    const raw = await getTokenRawBalance(mint);
    if (raw <= 0n) throw new Error('No balance');
    const toSell = (raw * BigInt(Math.floor(pct))) / 100n;
    const res = await smartSell({ mint, amountRaw: toSell });
    if (res.route === 'jupiter') {
      ctx.reply(`Sold ${pct}% — received ~${(Number(res.outLamports||0n)/1e9).toFixed(6)} SOL (route: jupiter)`);
    } else {
      ctx.reply(`Sold ${pct}% via pumpportal (bonding curve).`);
    }
  } catch (e) { ctx.reply(`Sell failed: ${e.message}`); }
}));

bot.command('autobuy', authGuard(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const mint = parts[1];
  const solStr = parts[2] || DEFAULT_BUY_SOL;
  if (!mint) return ctx.reply(`Usage:\n  /autobuy <mint> [sol]`);
  const sol = Number(solStr);
  if (isNaN(sol) || sol <= 0) return ctx.reply('Invalid SOL amount.');
  try {
    await verifyMintExists(mint);
    const res = await smartBuy({ mint, amountSol: sol });
    positions[mint] = {
      mint,
      entrySolSpent: res.spentSol,
      entryTokenRecvRaw: (res.outRaw || 0n).toString(),
      tpPct: SCALP_TP_PCT,
      slPct: SCALP_SL_PCT,
      createdAt: new Date().toISOString(),
      lastCheck: null,
      profileUsed: 'SCALP-THIN',
      tookPartialTP: false
    };
    savePositions();
    ctx.reply(`Auto-buy ✅ ${mint}\nSpent: ${res.spentSol.toFixed(6)} SOL\nRoute: ${res.route}\nTP: +${SCALP_TP_PCT}% | SL: -${SCALP_SL_PCT}%`);
  } catch (e) { ctx.reply(`Autobuy failed: ${e.message}`); }
}));

bot.command('status', authGuard((ctx) => {
  if (!Object.keys(positions).length) return ctx.reply('No active positions.');
  let msg = 'Active positions:\n';
  for (const p of Object.values(positions)) {
    msg += `\n• ${p.mint}\n  Entry: ${p.entrySolSpent} SOL for ${p.entryTokenRecvRaw} raw\n  TP: +${p.tpPct}% | SL: -${p.slPct}% (Profile: ${p.profileUsed})\n  Partial TP: ${p.tookPartialTP ? 'Yes' : 'No'}\n  Since: ${p.createdAt}\n`;
  }
  ctx.reply(msg);
}));

bot.command('cancel', authGuard((ctx) => {
  const [, mint] = ctx.message.text.trim().split(/\s+/);
  if (!mint) return ctx.reply('Usage: /cancel <mint>');
  if (!positions[mint]) return ctx.reply('No such position.');
  delete positions[mint];
  savePositions();
  ctx.reply(`Canceled monitoring for ${mint}.`);
}));

bot.command('autopilot', authGuard(async (ctx) => {
  const [, sub] = ctx.message.text.trim().split(/\s+/);

  if (!sub || sub === 'status') {
    const minsLeft = Math.max(0, Math.ceil((AUTOPILOT.cooldownMs - (Date.now() - AUTOPILOT.lastBuyAt)) / 60000));
    return ctx.reply(
`🤖 Autopilot: ${AUTOPILOT.enabled ? 'ON' : 'OFF'}
Budget/Buy: ${AUTOPILOT.budgetSol} SOL
Max Open: ${AUTOPILOT.maxOpen}
Momentum gates:
  15s:  buys≥${AUTOPILOT.minBuys15s}  chg≥${AUTOPILOT.minChange15s}%
  30s:  buys≥${AUTOPILOT.minBuys30s}  chg≥${AUTOPILOT.minChange30s}%
   1m:  buys≥${AUTOPILOT.minBuys1m}   chg≥${AUTOPILOT.minChange1m}%
   5m:  buys≥${AUTOPILOT.minBuys5m}   chg≥${AUTOPILOT.minChange5m}%
Cooldown: ${(AUTOPILOT.cooldownMs/60000)|0} min (next in ~${minsLeft}m)
Blacklist (${AUTOPILOT.blacklist.length}): ${AUTOPILOT.blacklist.slice(0,5).join(', ')}${AUTOPILOT.blacklist.length>5?'…':''}`
    );
  }
  if (sub === 'on') { AUTOPILOT.enabled = true; saveAutopilotCfg(); return ctx.reply('✅ Autopilot ON'); }
  if (sub === 'off') { AUTOPILOT.enabled = false; saveAutopilotCfg(); return ctx.reply('⏸️ Autopilot OFF'); }
  return ctx.reply('Usage: /autopilot on | off | status');
}));

bot.command('autofilters', authGuard((ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length === 1) {
    return ctx.reply(
`Autopilot Filters:
budget <SOL>           (current: ${AUTOPILOT.budgetSol})
maxopen <N>            (current: ${AUTOPILOT.maxOpen})
minbuys15s <N>         (current: ${AUTOPILOT.minBuys15s})
minchg15s <PCT>        (current: ${AUTOPILOT.minChange15s})
minbuys30s <N>         (current: ${AUTOPILOT.minBuys30s})
minchg30s <PCT>        (current: ${AUTOPILOT.minChange30s})
minbuys1m <N>          (current: ${AUTOPILOT.minBuys1m})
minchg1m <PCT>         (current: ${AUTOPILOT.minChange1m})
minbuys5m <N>          (current: ${AUTOPILOT.minBuys5m})
minchg5m <PCT>         (current: ${AUTOPILOT.minChange5m})
cooldown <MINUTES>     (current: ${(AUTOPILOT.cooldownMs/60000)|0})
blacklist add <MINT> | remove <MINT> | show`
    );
  }
  const cmd = parts[1]?.toLowerCase();
  const val = parts[2];

  function numOrErr(v, name) {
    const n = Number(v);
    if (!isFinite(n) || n < 0) throw new Error(`Invalid ${name}`);
    return n;
  }

  try {
    if (cmd === 'budget') { AUTOPILOT.budgetSol = numOrErr(val, 'budget'); saveAutopilotCfg(); return ctx.reply(`✔️ budgetSol = ${AUTOPILOT.budgetSol} SOL`); }
    if (cmd === 'maxopen') { AUTOPILOT.maxOpen = Math.max(0, Math.floor(numOrErr(val, 'maxopen'))); saveAutopilotCfg(); return ctx.reply(`✔️ maxOpen = ${AUTOPILOT.maxOpen}`); }

    // Sub-minute & minute gates
    if (cmd === 'minbuys15s') { AUTOPILOT.minBuys15s = Math.floor(numOrErr(val, 'minbuys15s')); saveAutopilotCfg(); return ctx.reply(`✔️ minBuys15s = ${AUTOPILOT.minBuys15s}`); }
    if (cmd === 'minchg15s')  { AUTOPILOT.minChange15s = numOrErr(val, 'minchg15s'); saveAutopilotCfg(); return ctx.reply(`✔️ minChange15s = ${AUTOPILOT.minChange15s}%`); }
    if (cmd === 'minbuys30s') { AUTOPILOT.minBuys30s = Math.floor(numOrErr(val, 'minbuys30s')); saveAutopilotCfg(); return ctx.reply(`✔️ minBuys30s = ${AUTOPILOT.minBuys30s}`); }
    if (cmd === 'minchg30s')  { AUTOPILOT.minChange30s = numOrErr(val, 'minchg30s'); saveAutopilotCfg(); return ctx.reply(`✔️ minChange30s = ${AUTOPILOT.minChange30s}%`); }
    if (cmd === 'minbuys1m')  { AUTOPILOT.minBuys1m  = Math.floor(numOrErr(val, 'minbuys1m'));  saveAutopilotCfg(); return ctx.reply(`✔️ minBuys1m = ${AUTOPILOT.minBuys1m}`); }
    if (cmd === 'minchg1m')   { AUTOPILOT.minChange1m = numOrErr(val, 'minchg1m'); saveAutopilotCfg(); return ctx.reply(`✔️ minChange1m = ${AUTOPILOT.minChange1m}%`); }
    if (cmd === 'minbuys5m')  { AUTOPILOT.minBuys5m  = Math.floor(numOrErr(val, 'minbuys5m'));  saveAutopilotCfg(); return ctx.reply(`✔️ minBuys5m = ${AUTOPILOT.minBuys5m}`); }
    if (cmd === 'minchg5m')   { AUTOPILOT.minChange5m = numOrErr(val, 'minchg5m'); saveAutopilotCfg(); return ctx.reply(`✔️ minChange5m = ${AUTOPILOT.minChange5m}%`); }

    if (cmd === 'cooldown') {
      const mins = numOrErr(val, 'cooldown');
      AUTOPILOT.cooldownMs = Math.max(0, Math.floor(mins * 60 * 1000));
      saveAutopilotCfg(); return ctx.reply(`✔️ cooldown = ${(AUTOPILOT.cooldownMs/60000)|0} min`);
    }

    if (cmd === 'blacklist') {
      const sub = (parts[2] || '').toLowerCase();
      const mint = parts[3];
      if (sub === 'show') {
        const list = AUTOPILOT.blacklist;
        return ctx.reply(list.length ? `Blacklist (${list.length}):\n${list.join('\n')}` : 'Blacklist is empty.');
      }
      if (sub === 'add') {
        if (!mint) return ctx.reply('Usage: /autofilters blacklist add <MINT>');
        if (!AUTOPILOT.blacklist.includes(mint)) AUTOPILOT.blacklist.push(mint);
        saveAutopilotCfg(); return ctx.reply(`✔️ added: ${mint}`);
      }
      if (sub === 'remove') {
        if (!mint) return ctx.reply('Usage: /autofilters blacklist remove <MINT>');
        AUTOPILOT.blacklist = AUTOPILOT.blacklist.filter(m => m !== mint);
        saveAutopilotCfg(); return ctx.reply(`✔️ removed: ${mint}`);
      }
      return ctx.reply('Usage: /autofilters blacklist show|add <MINT>|remove <MINT>');
    }

    return ctx.reply('Unknown subcommand. Send /autofilters to see options.');
  } catch (e) { return ctx.reply(`⚠️ ${e.message}`); }
}));

// -------------------- DEBUG: /scan uses Pump signals --------------------
bot.command('scan', authGuard(async (ctx) => {
  const cands = selectCandidatesFromPump();
  const top = cands.slice(0, 5).map(m => {
    const x = feed.metrics(m);
    return `${m} | 15s:+${x.chg15s.toFixed(1)}%(${x.buys15s}) 30s:+${x.chg30s.toFixed(1)}%(${x.buys30s}) 1m:+${x.chg1m.toFixed(1)}%(${x.buys1m}) 5m:+${x.chg5m.toFixed(1)}%(${x.buys5m})`;
  });
  ctx.reply(`[SCAN] candidates=${cands.length}${top.length ? '\nTop:\n' + top.join('\n') : ''}`);
}));

// Try a tiny test route for a mint (Jupiter sanity)
bot.command('autosim', authGuard(async (ctx) => {
  const [, mint, solStr] = ctx.message.text.trim().split(/\s+/);
  const testSol = Number(solStr || AUTOPILOT.budgetSol || 0.01);
  if (!mint || !isFinite(testSol) || testSol <= 0) {
    return ctx.reply('Usage: /autosim <MINT> [SOL]');
  }
  try {
    await verifyMintExists(mint);
    const lamports = Math.floor(Math.max(testSol, 0.005) * 1e9);
    const buyRoute = await jupQuote({
      inputMint: WSOL_MINT,
      outputMint: mint,
      amountRaw: lamports,
      slippageBps: THIN.SLIPPAGE_BASE
    });
    const sellRoute = await jupQuote({
      inputMint: mint,
      outputMint: WSOL_MINT,
      amountRaw: String(Math.max(1n, BigInt(buyRoute?.outAmount || 0) / 5n)),
      slippageBps: THIN.SLIPPAGE_BASE
    });
    const impact = Number(buyRoute?.priceImpactPct ?? NaN);
    ctx.reply(
      `Autosim ✅\nMint: ${mint}\nIn: ${(lamports/1e9).toFixed(6)} SOL → OutRaw: ${buyRoute?.outAmount}\nPriceImpact: ${isFinite(impact)?impact.toFixed(2):'n/a'}%\nSellRouteOutLamports: ~${(Number(sellRoute?.outAmount||0)/1e9).toFixed(6)} SOL`
    );
  } catch (e) {
    ctx.reply(`Autosim ❌ ${e.message}`);
  }
}));

// -------------------- MONITOR LOOP: TP/SL (uses Jupiter mark for P&L) --------------------
async function monitorPositions() {
  const now = new Date().toISOString();
  for (const mint of Object.keys(positions)) {
    try {
      const p = positions[mint];
      const tokenBalRaw = await getTokenRawBalance(mint);
      if (tokenBalRaw <= 0n) { delete positions[mint]; savePositions(); continue; }

      const estLamports = await estimateSolForToken({ mint, amountRaw: tokenBalRaw });
      const estSol = Number(estLamports) / 1e9;
      const entrySol = Number(p.entrySolSpent);
      if (entrySol <= 0) continue;

      const pnlPct = ((estSol - entrySol) / entrySol) * 100;
      positions[mint].lastCheck = now;

      const hitTP = pnlPct >= p.tpPct;
      const hitSL = pnlPct <= -p.slPct;

      if (!hitTP && !hitSL) continue;

      if (hitSL) {
        const res = await smartSell({ mint, amountRaw: tokenBalRaw });
        if (lastChatId) bot.telegram.sendMessage(lastChatId, `🔻 SL hit ${mint} at ~${pnlPct.toFixed(2)}%\nExited${res.route==='jupiter'?` ~${(Number(res.outLamports||0n)/1e9).toFixed(6)} SOL`:''}.`);
        delete positions[mint]; savePositions(); continue;
      }

      if (hitTP) {
        // FULL EXIT on TP when partials disabled
        if (String(PARTIAL_TP_ENABLED || 'false').toLowerCase() !== 'true') {
          const res = await smartSell({ mint, amountRaw: tokenBalRaw });
          if (lastChatId) bot.telegram.sendMessage(
            lastChatId,
            `🏁 TP hit ${mint} at ~${pnlPct.toFixed(2)}%\nExited 100%${res.route==='jupiter'?` — ~${(Number(res.outLamports||0n)/1e9).toFixed(6)} SOL`:''}.`
          );
          delete positions[mint]; savePositions(); continue;
        }

        // partial TP then final
        if (!p.tookPartialTP) {
          const toSell = tokenBalRaw / 2n;
          if (toSell > 0n) {
            const res = await smartSell({ mint, amountRaw: toSell });
            positions[mint].slPct = 0; positions[mint].tookPartialTP = true; savePositions();
            if (lastChatId) bot.telegram.sendMessage(lastChatId, `✅ Partial TP ${mint} at ~${pnlPct.toFixed(2)}%\nSold 50%${res.route==='jupiter'?` — ~${(Number(res.outLamports||0n)/1e9).toFixed(6)} SOL`:''}. SL → breakeven.`);
          }
          continue;
        } else {
          const res = await smartSell({ mint, amountRaw: tokenBalRaw });
          if (lastChatId) bot.telegram.sendMessage(lastChatId, `🏁 Final TP ${mint} at ~${pnlPct.toFixed(2)}%\nExited${res.route==='jupiter'?` ~${(Number(res.outLamports||0n)/1e9).toFixed(6)} SOL`:''}.`);
          delete positions[mint]; savePositions(); continue;
        }
      }
    } catch (err) {
      console.error('[Monitor error]', mint, err.message);
    }
  }
}
setInterval(monitorPositions, Number(POLL_SECONDS) * 1000);

// -------------------- AUTOPILOT: candidate selection from Pump signals --------------------
function selectCandidatesFromPump() {
  const openCount = Object.keys(positions).length;
  const room = Math.max(0, AUTOPILOT.maxOpen - openCount);
  if (room === 0) return [];

  const now = Date.now();
  const picks = [];

  for (const [mint, _bucket] of feed.byMint.entries()) {
    if (AUTOPILOT.blacklist.includes(mint)) continue;
    if (positions[mint]) continue;

    const baseLast = AUTOPILOT.lastTried[mint] || 0;
    if (now - baseLast < AUTOPILOT.cooldownMs) continue;

    const m = feed.metrics(mint);
    if (!m || !isFinite(m.priceNowSol) || m.priceNowSol <= 0) continue;

    // Momentum gates (sub-minute first)
    if (m.buys15s  < AUTOPILOT.minBuys15s)    continue;
    if (m.chg15s   < AUTOPILOT.minChange15s)  continue;
    if (m.buys30s  < AUTOPILOT.minBuys30s)    continue;
    if (m.chg30s   < AUTOPILOT.minChange30s)  continue;

    // Minute/5m
    if (m.buys1m   < AUTOPILOT.minBuys1m)     continue;
    if (m.chg1m    < AUTOPILOT.minChange1m)   continue;
    if (m.buys5m   < AUTOPILOT.minBuys5m)     continue;
    if (m.chg5m    < AUTOPILOT.minChange5m)   continue;

    // Score with extra weight to sub-minute bursts + 1m momo
    const w = AUTOPILOT.momoWeight || 1.8;
    const score =
      (m.buys15s * 2.5) + (m.chg15s * 3.0) +
      (m.buys30s * 1.8) + (m.chg30s * 2.2) +
      (m.buys1m  * 1.2 * w) + (m.chg1m * 1.5 * w) +
      (m.buys5m  * 0.8) + (m.chg5m * 1.0);

    picks.push({ mint, score });
  }

  return picks.sort((a,b)=>b.score - a.score).slice(0, room).map(p => p.mint);
}

async function autopilotLoop() {
  if (!AUTOPILOT.enabled) return;
  try {
    if (Date.now() - AUTOPILOT.lastBuyAt < AUTOPILOT.cooldownMs) return;

    const candidates = selectCandidatesFromPump();
    if (!candidates.length) return;

    for (const mint of candidates) {
      try {
        AUTOPILOT.lastTried[mint] = Date.now(); saveAutopilotCfg();
        await verifyMintExists(mint);

        const res = await smartBuy({ mint, amountSol: AUTOPILOT.budgetSol });

        positions[mint] = {
          mint,
          entrySolSpent: res.spentSol,
          entryTokenRecvRaw: (res.outRaw || 0n).toString(),
          tpPct: SCALP_TP_PCT,
          slPct: SCALP_SL_PCT,
          createdAt: new Date().toISOString(),
          lastCheck: null,
          profileUsed: 'SCALP-THIN-AUTO(PUMP)',
          tookPartialTP: false
        };
        savePositions();

        AUTOPILOT.lastBuyAt = Date.now(); saveAutopilotCfg();

        const msg = `🤖 Autopilot BUY (Pump)\nMint: ${mint}\nSpent: ${res.spentSol.toFixed(6)} SOL\nRoute: ${res.route}\nTP: +${SCALP_TP_PCT}% | SL: -${SCALP_SL_PCT}%`;
        console.log(msg);
        if (lastChatId) bot.telegram.sendMessage(lastChatId, msg);

        break; // one buy per cooldown
      } catch (e) {
        console.error('[Autopilot buy error]', mint, e.message);
      }
    }
  } catch (e) {
    console.error('[Autopilot loop]', e.message);
  }
}
setInterval(autopilotLoop, 60 * 1000);

// -------------------- START --------------------
async function assertTelegramToken() {
  try {
    const me = await bot.telegram.getMe();
    console.log(`Telegram token OK. Connected as @${me.username} (id=${me.id}).`);
  } catch (e) {
    console.error('Invalid TELEGRAM_BOT_TOKEN (401). In @BotFather: /revoke then /token. Update env and redeploy.');
    process.exit(1);
  }
}

async function resetWebhookAndLaunch() {
  try {
    await assertTelegramToken();
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch();
    console.log(`Bot launched with long polling. Wallet: ${keypair.publicKey.toBase58()}`);
  } catch (e) {
    const code = e?.response?.error_code;
    if (code === 409) {
      console.error('409 Conflict: another instance is polling. Stop other copies or rotate token in @BotFather (/revoke → /token).');
    } else {
      console.error('Failed to launch bot:', e);
    }
    process.exit(1);
  }
}
resetWebhookAndLaunch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
