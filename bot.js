// bot.js — Thin-Liquidity SCALP Bot for Solana with robust auth and safe long-polling launcher

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

  // Thin-liquidity tuning
  THIN_MAX_SLIPPAGE_BPS_BASE = '200',
  THIN_MAX_SLIPPAGE_BPS_CAP  = '500',
  THIN_TARGET_IMPACT_PCT     = '2.0',
  THIN_HARD_IMPACT_PCT       = '5.0',
  THIN_MAX_SHARDS            = '5',
  THIN_MIN_SHARD_SOL         = '0.005',
  THIN_SHARD_DELAY_MS        = '800',
  THIN_EXIT_SHARDS           = '3',
  THIN_EXIT_DELAY_MS         = '1200'
} = process.env;

// -------------------- BASIC CHECKS --------------------
if (!WALLET_PRIVATE_KEY_BASE58) {
  console.error('Missing WALLET_PRIVATE_KEY_BASE58.');
  process.exit(1);
}
if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN.');
  process.exit(1);
}

// -------------------- AUTH --------------------
const USER_ALLOWLIST = TELEGRAM_ALLOWED_USER_ID.split(',')
  .map(s => s.trim())
  .filter(Boolean);
const CHAT_ALLOWLIST = TELEGRAM_ALLOWED_CHAT_ID.split(',')
  .map(s => s.trim())
  .filter(Boolean);
function allowed(ctx) {
  const fromId = String(ctx.from?.id || '');
  const chatId = String(ctx.chat?.id || '');
  const userOk = USER_ALLOWLIST.includes(fromId);
  const chatOk = CHAT_ALLOWLIST.includes(chatId);
  return userOk || chatOk;
}

// -------------------- KEYPAIR --------------------
let keypair;
try {
  const secretBytes = bs58.decode(WALLET_PRIVATE_KEY_BASE58);
  keypair = Keypair.fromSecretKey(Uint8Array.from(secretBytes));
} catch (err) {
  console.error('Failed to decode WALLET_PRIVATE_KEY_BASE58.');
  process.exit(1);
}
console.log('Bot wallet public key:', keypair.publicKey.toBase58());

// -------------------- SETUP --------------------
const connection = new Connection(RPC_URL, 'confirmed');
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// --- constants for scalp logic (trimmed for brevity) ---
const SCALP_TP_PCT = 20;
const SCALP_SL_PCT = 10;
const THIN = {
  SLIPPAGE_BASE: Number(THIN_MAX_SLIPPAGE_BPS_BASE),
  SLIPPAGE_CAP: Number(THIN_MAX_SLIPPAGE_BPS_CAP),
  TARGET_IMPACT: Number(THIN_TARGET_IMPACT_PCT),
  HARD_IMPACT: Number(THIN_HARD_IMPACT_PCT),
  MAX_SHARDS: Number(THIN_MAX_SHARDS),
  MIN_SHARD_SOL: Number(THIN_MIN_SHARD_SOL),
  SHARD_DELAY_MS: Number(THIN_SHARD_DELAY_MS),
  EXIT_SHARDS: Number(THIN_EXIT_SHARDS),
  EXIT_DELAY_MS: Number(THIN_EXIT_DELAY_MS)
};

// -------------------- DEBUG LOGGER --------------------
if (String(DEBUG_IDS).toLowerCase() === 'true') {
  bot.on('message', (ctx, next) => {
    console.log('DBG from.id=', ctx.from?.id, 'chat.id=', ctx.chat?.id, 'username=@' + (ctx.from?.username || 'n/a'));
    return next();
  });
}

// -------------------- STATE & HELPERS (trimmed) --------------------
const POSITIONS_FILE = './positions.json';
function loadPositions() {
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf-8')); }
  catch { return {}; }
}
function savePositions() {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}
let positions = loadPositions();
let lastChatId = null;

// --- Jupiter, trading, and monitor helpers omitted for brevity ---
// (keep your existing jupQuote, buyBySol, sellTokensForSol, monitorPositions, etc.)

// -------------------- TELEGRAM COMMANDS --------------------
function authGuard(handler) {
  return (ctx) => {
    if (!allowed(ctx)) return ctx.reply('Not authorized.');
    return handler(ctx);
  };
}

bot.command('whoami', (ctx) =>
  ctx.reply(`Your user id: ${ctx.from?.id}\nChat id: ${ctx.chat?.id}\nUsername: @${ctx.from?.username || 'n/a'}`)
);

bot.start(authGuard((ctx) => {
  lastChatId = ctx.chat?.id || lastChatId;
  ctx.reply(
`Ready. Commands:
/whoami
/bal
/buy <mint> [sol]
/sell <mint> [percent]
/autobuy <mint> [sol]
/status
/cancel <mint>

Wallet: ${keypair.publicKey.toBase58()}`
  );
}));

// ... keep your other command handlers (/bal, /buy, /sell, /autobuy, /status, /cancel) here ...

// -------------------- SAFE LONG-POLLING LAUNCHER --------------------
async function resetWebhookAndLaunch() {
  try {
    // clear any existing Telegram webhook and pending messages
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    await bot.launch();
    console.log(`Bot launched with long polling. Wallet: ${keypair.publicKey.toBase58()}`);
  } catch (err) {
    console.error('Failed to launch bot:', err);
    process.exit(1);
  }
}
resetWebhookAndLaunch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
