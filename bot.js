// bot.js — Fully-automated thin-liquidity SCALP bot for Solana
// Features: Auth, whoami/authstatus, sharded buys/sells, TP/SL monitor,
// Autopilot (Dexscreener) with Telegram toggle & filter editing,
// Dexscreener fetch via search endpoint (chain:solana) with retries/fallbacks,
// Debug commands: /scan (force scan), /autosim (routing sanity).

import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import { Telegraf } from 'telegraf';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction
} from '@solana/web3.js';

import dns from 'node:dns';              // ← add (or keep) this
dns.setDefaultResultOrder('ipv4first');  // ← and this

// at the very top of bot.js (after imports)
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

  // Initial AUTOPILOT defaults (persisted to autopilot.json on first run)
  AUTOPILOT_ENABLED = 'false',
  AUTOPILOT_BUDGET_SOL_PER_BUY = '0.02',
  AUTOPILOT_MAX_OPEN_POSITIONS = '3',
  AUTOPILOT_MIN_LIQ_USD = '6000',
  AUTOPILOT_MIN_5M_VOLUME_USD = '1500',
  AUTOPILOT_MIN_5M_BUY_TX = '20',
  AUTOPILOT_MIN_5M_PRICE_CHANGE_PCT = '4',
  AUTOPILOT_COOLDOWN_MIN = '30',
  AUTOPILOT_BLACKLIST = ''
} = process.env;   // ←←← CLOSE the destructure and end with a semicolon
// ^^^^^^^^^^^^^^^^ very important line

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
const SCALP_TP_PCT = 20; // take profit +20%
const SCALP_SL_PCT = 10; // stop loss -10%

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
  minLiqUsd: Number(AUTOPILOT_MIN_LIQ_USD),
  minVol5m: Number(AUTOPILOT_MIN_5M_VOLUME_USD),
  minBuys5m: Number(AUTOPILOT_MIN_5M_BUY_TX),
  minChange5m: Number(AUTOPILOT_MIN_5M_PRICE_CHANGE_PCT),
  cooldownMs: Number(AUTOPILOT_COOLDOWN_MIN) * 60 * 1000,
  blacklist: (AUTOPILOT_BLACKLIST || '').split(',').map(s => s.trim()).filter(Boolean),
  lastBuyAt: 0,
  lastTried: {} // mint -> ts
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
// -------------------- JUPITER HELPERS --------------------
const JUPITER_BASE = process.env.JUPITER_BASE || 'https://quote-api.jup.ag';

function buildJupUrl(base, path) {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${b}${path.startsWith('/') ? '' : '/'}${path}`;
}

async function fetchJsonWithFallback(path, init = {}) {
  const bases = [JUPITER_BASE, 'https://quote-api.jup.ag'];
  let lastErr;
  for (const base of bases) {
    try {
      const url = buildJupUrl(base, path);
      const r = await fetch(url, { headers: { 'Accept': 'application/json' }, ...init });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        if (r.status >= 500) { lastErr = new Error(`(${r.status}) ${text.slice(0,180)}`); continue; }
        throw new Error(`(${r.status} ${r.statusText}) ${text.slice(0,180)}`);
      }
      return await r.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Jupiter request failed on all bases: ${lastErr?.message || lastErr}`);
}

async function jupQuote({ inputMint, outputMint, amountRaw, slippageBps }) {
  const params = new URLSearchParams();
  params.set('inputMint', inputMint);
  params.set('outputMint', outputMint);
  params.set('amount', String(amountRaw));
  params.set('slippageBps', String(slippageBps));
  params.set('onlyDirectRoutes', 'false');

  const data = await fetchJsonWithFallback(`/v6/quote?${params.toString()}`);
  if (!data?.data?.[0]) throw new Error('No route');
  return data.data[0];
}

async function jupBuildAndSend({ quoteResponse }) {
  const body = JSON.stringify({
    quoteResponse,
    userPublicKey: keypair.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true
  });

  const data = await fetchJsonWithFallback('/v6/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  });

  const { swapTransaction } = data;
  if (!swapTransaction) throw new Error('No swapTransaction in response');

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([keypair]);

  const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
  const conf = await connection.confirmTransaction(sig, 'confirmed');
  if (conf.value.err) throw new Error(`Swap failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

function extractImpactPct(route) {
  if (route?.priceImpactPct != null) return Number(route.priceImpactPct);
  return NaN;
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

// -------------------- THIN-LIQ BUY & SELL --------------------
async function buyBySol({ mint, amountSol, slippageBps }) {
  let remainingSol = Number(amountSol);
  let spentLamports = 0n;
  let receivedRaw = 0n;
  let shards = 0;
  let curSlip = Math.min(Number(slippageBps || THIN.SLIPPAGE_BASE), THIN.SLIPPAGE_CAP);

  while (remainingSol > 0 && shards < THIN.MAX_SHARDS) {
    const proposedSol = Math.max(
      Math.min(remainingSol, Number((amountSol / THIN.MAX_SHARDS).toFixed(6))),
      THIN.MIN_SHARD_SOL
    );
    const lamports = Math.floor(proposedSol * 1e9);

    const route = await jupQuote({ inputMint: WSOL_MINT, outputMint: mint, amountRaw: lamports, slippageBps: curSlip });
    const impact = extractImpactPct(route);

    if (!Number.isNaN(impact) && impact > THIN.HARD_IMPACT) {
      if (proposedSol <= THIN.MIN_SHARD_SOL + 1e-9) throw new Error(`Price impact too high (${impact.toFixed(2)}%).`);
      remainingSol = Math.max(remainingSol - proposedSol / 2, 0);
      continue;
    }

    if (!Number.isNaN(impact) && impact > THIN.TARGET_IMPACT && proposedSol > THIN.MIN_SHARD_SOL) {
      const smallerSol = Math.max(proposedSol / 2, THIN.MIN_SHARD_SOL);
      const smallerLamports = Math.floor(smallerSol * 1e9);
      const smallerRoute = await jupQuote({ inputMint: WSOL_MINT, outputMint: mint, amountRaw: smallerLamports, slippageBps: curSlip });
      const smallerImpact = extractImpactPct(smallerRoute);

      if (!Number.isNaN(smallerImpact) && smallerImpact <= impact) {
        await jupBuildAndSend({ quoteResponse: smallerRoute });
        spentLamports += BigInt(smallerRoute.inAmount || smallerLamports);
        receivedRaw   += BigInt(smallerRoute.outAmount);
        remainingSol  -= smallerSol;
        shards++;
        await new Promise(r => setTimeout(r, THIN.SHARD_DELAY_MS));
        continue;
      }
    }

    await jupBuildAndSend({ quoteResponse: route });
    spentLamports += BigInt(route.inAmount || lamports);
    receivedRaw   += BigInt(route.outAmount);
    remainingSol  -= proposedSol;
    shards++;
    await new Promise(r => setTimeout(r, THIN.SHARD_DELAY_MS));
  }

  if (receivedRaw <= 0n) throw new Error('Buy produced zero output.');
  return {
    sig: '(multiple shards)',
    outAmountRaw: receivedRaw,
    totalSpentLamports: spentLamports,
    shardsExecuted: shards
  };
}

async function sellTokensForSol({ mint, amountRaw, slippageBps }) {
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
      slippageBps: Math.min(Number(slippageBps || THIN.SLIPPAGE_BASE), THIN.SLIPPAGE_CAP)
    });

    await jupBuildAndSend({ quoteResponse: route });
    soldLamports += BigInt(route.outAmount);
    remaining    -= BigInt(route.inAmount || slice);

    await new Promise(r => setTimeout(r, THIN.EXIT_DELAY_MS));
  }

  return { sig: '(multiple shards)', outLamports: soldLamports };
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
    const { outAmountRaw, totalSpentLamports, shardsExecuted } = await buyBySol({
      mint, amountSol: sol, slippageBps: THIN.SLIPPAGE_BASE
    });
    ctx.reply(`Bought ${(Number(totalSpentLamports)/1e9).toFixed(6)} SOL of ${mint}\nReceived (raw): ${outAmountRaw}\nShards: ${shardsExecuted}`);
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
    const { outLamports } = await sellTokensForSol({ mint, amountRaw: toSell, slippageBps: THIN.SLIPPAGE_BASE });
    ctx.reply(`Sold ${pct}% — received ~${(Number(outLamports)/1e9).toFixed(6)} SOL`);
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
    const { outAmountRaw, totalSpentLamports, shardsExecuted } = await buyBySol({
      mint, amountSol: sol, slippageBps: THIN.SLIPPAGE_BASE
    });
    positions[mint] = {
      mint,
      entrySolSpent: Number(totalSpentLamports)/1e9,
      entryTokenRecvRaw: outAmountRaw.toString(),
      tpPct: SCALP_TP_PCT,
      slPct: SCALP_SL_PCT,
      createdAt: new Date().toISOString(),
      lastCheck: null,
      profileUsed: 'SCALP-THIN',
      tookPartialTP: false
    };
    savePositions();
    ctx.reply(`Auto-buy ✅ ${mint}\nSpent: ${(Number(totalSpentLamports)/1e9).toFixed(6)} SOL\nShards: ${shardsExecuted}\nTP: +${SCALP_TP_PCT}% | SL: -${SCALP_SL_PCT}%`);
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

// -------------------- AUTOPILOT COMMANDS --------------------
bot.command('autopilot', authGuard(async (ctx) => {
  const [, sub] = ctx.message.text.trim().split(/\s+/);

  if (!sub || sub === 'status') {
    const minsLeft = Math.max(0, Math.ceil((AUTOPILOT.cooldownMs - (Date.now() - AUTOPILOT.lastBuyAt)) / 60000));
    return ctx.reply(
`🤖 Autopilot: ${AUTOPILOT.enabled ? 'ON' : 'OFF'}
Budget/Buy: ${AUTOPILOT.budgetSol} SOL
Max Open: ${AUTOPILOT.maxOpen}
Filters:
  minLiqUsd=${AUTOPILOT.minLiqUsd}
  minVol5m=${AUTOPILOT.minVol5m}
  minBuys5m=${AUTOPILOT.minBuys5m}
  minChange5m=${AUTOPILOT.minChange5m}%
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
minliq <USD>           (current: ${AUTOPILOT.minLiqUsd})
minvol5m <USD>         (current: ${AUTOPILOT.minVol5m})
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
    if (cmd === 'minliq') { AUTOPILOT.minLiqUsd = numOrErr(val, 'minliq'); saveAutopilotCfg(); return ctx.reply(`✔️ minLiqUsd = ${AUTOPILOT.minLiqUsd}`); }
    if (cmd === 'minvol5m') { AUTOPILOT.minVol5m = numOrErr(val, 'minvol5m'); saveAutopilotCfg(); return ctx.reply(`✔️ minVol5m = ${AUTOPILOT.minVol5m}`); }
    if (cmd === 'minbuys5m') { AUTOPILOT.minBuys5m = Math.floor(numOrErr(val, 'minbuys5m')); saveAutopilotCfg(); return ctx.reply(`✔️ minBuys5m = ${AUTOPILOT.minBuys5m}`); }
    if (cmd === 'minchg5m') { AUTOPILOT.minChange5m = numOrErr(val, 'minchg5m'); saveAutopilotCfg(); return ctx.reply(`✔️ minChange5m = ${AUTOPILOT.minChange5m}%`); }
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

// -------------------- DEBUG COMMANDS --------------------
// Force a scan now (does not buy; shows how many candidates)
bot.command('scan', authGuard(async (ctx) => {
  try {
    const pairs = await fetchDexScreenerSolanaPairs();
    ctx.reply(`[SCAN] fetched ${pairs.length} pairs. Filtering...`);
    const cands = selectCandidates(pairs);
    ctx.reply(`[SCAN] candidates=${cands.length}${cands.length? '\nTop: ' + cands.slice(0,5).join('\n') : ''}`);
  } catch (e) {
    ctx.reply(`[SCAN] error: ${e.message}`);
  }
}));

// Try a tiny test route for a mint
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

// -------------------- MONITOR LOOP: TP/SL --------------------
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
        const { outLamports } = await sellTokensForSol({ mint, amountRaw: tokenBalRaw, slippageBps: THIN.SLIPPAGE_BASE });
        if (lastChatId) bot.telegram.sendMessage(lastChatId, `🔻 SL hit ${mint} at ~${pnlPct.toFixed(2)}%\nExited ~${(Number(outLamports)/1e9).toFixed(6)} SOL.`);
        delete positions[mint]; savePositions(); continue;
      }

      if (hitTP) {
        if (!p.tookPartialTP) {
          const toSell = tokenBalRaw / 2n;
          if (toSell > 0n) {
            const { outLamports } = await sellTokensForSol({ mint, amountRaw: toSell, slippageBps: THIN.SLIPPAGE_BASE });
            positions[mint].slPct = 0; positions[mint].tookPartialTP = true; savePositions();
            if (lastChatId) bot.telegram.sendMessage(lastChatId, `✅ Partial TP ${mint} at ~${pnlPct.toFixed(2)}%\nSold 50%, SL → breakeven.\nRealized ~${(Number(outLamports)/1e9).toFixed(6)} SOL.`);
          }
          continue;
        } else {
          const { outLamports } = await sellTokensForSol({ mint, amountRaw: tokenBalRaw, slippageBps: THIN.SLIPPAGE_BASE });
          if (lastChatId) bot.telegram.sendMessage(lastChatId, `🏁 Final TP ${mint} at ~${pnlPct.toFixed(2)}%\nExited ~${(Number(outLamports)/1e9).toFixed(6)} SOL.`);
          delete positions[mint]; savePositions(); continue;
        }
      }
    } catch (err) {
      console.error('[Monitor error]', mint, err.message);
    }
  }
}
setInterval(monitorPositions, Number(POLL_SECONDS) * 1000);

// -------------------- DEXSCREENER FETCH via SEARCH (with mirror fallback) --------------------

async function fetchDexscreenerJson(path, { tries = 3 } = {}) {
  // Try your Worker first, then official API
  const envBase = (process.env.DEXSCREENER_BASE || '').replace(/\/$/, '');
  let bases = [
    envBase,                          // e.g. https://old-resonance-6acd.heitertluke.workers.dev/ds
    'https://api.dexscreener.com'     // fallback
  ].filter(Boolean);

  let lastErr;
  for (const base of bases) {
    const url = `${base}${path}`;
    for (let i = 1; i <= tries; i++) {
      try {
        const opts = {
          headers: { 'User-Agent': 'sol-autopilot/1.0', 'Accept': 'application/json' }
        };
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
          opts.signal = AbortSignal.timeout(15000);
        }

        const r = await fetch(url, opts);
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          // On explicit 403/404, switch to next base
          if (r.status === 403 || r.status === 404) {
            console.warn(`[DEX] ${r.status} at ${url} — switching base…`);
            break;
          }
          throw new Error(`HTTP ${r.status} ${r.statusText} — ${text.slice(0, 200)}`);
        }
        return await r.json();
      } catch (e) {
        lastErr = e;
        console.error(`[DEX] request failed (try ${i}/${tries}) ${url}:`, e.message);
        await new Promise(res => setTimeout(res, 1000 * i));
      }
    }
  }
  throw lastErr || new Error('All Dexscreener bases failed');
}

// ⬇️ INSERT THIS ENTIRE BLOCK RIGHT HERE

// -------------------- DEXSCREENER: get Solana pairs via search --------------------
async function fetchDexscreenerSolanaPairs() {
  try {
    const queries = ['chain:solana', 'solana raydium', 'solana orca'];
    for (const q of queries) {
      const data = await fetchDexscreenerJson(
        `/latest/dex/search?q=${encodeURIComponent(q)}`,
        { tries: 3 }
      );

      const pairs = Array.isArray(data?.pairs)
        ? data.pairs.filter(p =>
            p?.chainId === 'solana' || /solana/i.test(p?.chainId || '')
          )
        : [];

      if (pairs.length) return pairs;
      console.warn(`[DEX] search "${q}" returned 0 pairs, trying next…`);
    }
  } catch (e) {
    console.error('[DEX] search error:', e.message);
  }
  throw new Error('Dexscreener search returned no pairs');
}

// alias for code that calls fetchDexScreenerSolanaPairs()
const fetchDexScreenerSolanaPairs = fetchDexscreenerSolanaPairs;

// ⬆️ stop pasting here

// -------------------- AUTOPILOT: select + loop --------------------
function selectCandidates(pairs) {
  // ... rest of your file continues ...
  const openCount = Object.keys(positions).length;
  const room = Math.max(0, AUTOPILOT.maxOpen - openCount);
  if (room === 0) return [];

  const now = Date.now();
  const ban = new Set(AUTOPILOT.blacklist);

  // debugging counters
  const drop = {
    notSolana: 0, noBase: 0, blacklisted: 0,
    liq: 0, vol5m: 0, buys5m: 0, chg5m: 0,
    cooldown: 0, pass: 0
  };

  const filtered = pairs
    .filter(p => {
      try {
        const isSolana = p.chainId === 'solana' || /solana/i.test(p.chainId || '');
        if (!isSolana) { drop.notSolana++; return false; }
        const baseMint = p?.baseToken?.address;
        if (!baseMint) { drop.noBase++; return false; }
        if (ban.has(baseMint)) { drop.blacklisted++; return false; }

        const liqUsd   = Number(p?.liquidity?.usd || 0);
        const vol5m    = Number(p?.volume?.m5 || 0);
        const buys5m   = Number(p?.txns?.m5?.buys || 0);
        const change5m = Number(p?.priceChange?.m5 || 0);

        if (liqUsd   < AUTOPILOT.minLiqUsd)      { drop.liq++; return false; }
        if (vol5m    < AUTOPILOT.minVol5m)       { drop.vol5m++; return false; }
        if (buys5m   < AUTOPILOT.minBuys5m)      { drop.buys5m++; return false; }
        if (change5m < AUTOPILOT.minChange5m)    { drop.chg5m++; return false; }

        const baseLast = AUTOPILOT.lastTried[baseMint] || 0;
        if (now - baseLast < AUTOPILOT.cooldownMs) { drop.cooldown++; return false; }

        drop.pass++;
        return true;
      } catch {
        return false;
      }
    })
    .map(p => {
      const baseMint = p.baseToken.address;
      const score =
        (Number(p.txns?.m5?.buys || 0) * 2) +
        (Number(p.volume?.m5 || 0) / 500) +
        (Number(p.priceChange?.m5 || 0));
      return { baseMint, score };
    })
    .sort((a, b) => b.score - a.score);

  console.log('[AUTO] drop stats', {
    notSolana: drop.notSolana, noBase: drop.noBase, blacklisted: drop.blacklisted,
    liq: drop.liq, vol5m: drop.vol5m, buys5m: drop.buys5m, chg5m: drop.chg5m,
    perMintCooldown: drop.cooldown, pass: drop.pass
  });

  const picks = [];
  for (const { baseMint } of filtered) {
    if (picks.length >= room) break;
    if (positions[baseMint]) continue;
    picks.push(baseMint);
  }
  return picks;
}

async function autopilotLoop() {
  if (!AUTOPILOT.enabled) return;
  try {
    if (Date.now() - AUTOPILOT.lastBuyAt < AUTOPILOT.cooldownMs) return;

    const pairs = await fetchDexScreenerSolanaPairs();
    console.log(`[AUTO] fetched pairs: ${pairs.length}`);

    const candidates = selectCandidates(pairs);
    console.log(`[AUTO] candidates after filters: ${candidates.length}`, {
      minLiqUsd: AUTOPILOT.minLiqUsd,
      minVol5m: AUTOPILOT.minVol5m,
      minBuys5m: AUTOPILOT.minBuys5m,
      minChange5m: AUTOPILOT.minChange5m,
      maxOpen: AUTOPILOT.maxOpen,
      open: Object.keys(positions).length,
      budgetSol: AUTOPILOT.budgetSol
    });

    if (!candidates.length) return;

    for (const mint of candidates) {
      try {
        AUTOPILOT.lastTried[mint] = Date.now(); saveAutopilotCfg();
        await verifyMintExists(mint);

        const { outAmountRaw, totalSpentLamports, shardsExecuted } = await buyBySol({
          mint, amountSol: AUTOPILOT.budgetSol, slippageBps: THIN.SLIPPAGE_BASE
        });

        positions[mint] = {
          mint,
          entrySolSpent: Number(totalSpentLamports) / 1e9,
          entryTokenRecvRaw: outAmountRaw.toString(),
          tpPct: SCALP_TP_PCT,
          slPct: SCALP_SL_PCT,
          createdAt: new Date().toISOString(),
          lastCheck: null,
          profileUsed: 'SCALP-THIN-AUTO',
          tookPartialTP: false
        };
        savePositions();

        AUTOPILOT.lastBuyAt = Date.now(); saveAutopilotCfg();

        const msg = `🤖 Autopilot BUY\nMint: ${mint}\nSpent: ${(Number(totalSpentLamports)/1e9).toFixed(6)} SOL\nShards: ${shardsExecuted}\nTP: +${SCALP_TP_PCT}% | SL: -${SCALP_SL_PCT}%`;
        console.log(msg);
        if (lastChatId) bot.telegram.sendMessage(lastChatId, msg);

        break; // respect cooldown after one buy
      } catch (e) {
        console.error('[Autopilot buy error]', mint, e.message);
      }
    }
  } catch (e) {
    console.error('[Autopilot loop]', e.message);
  }
}
setInterval(autopilotLoop, 60 * 1000);

// -------------------- SAFE LONG-POLLING START --------------------
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
