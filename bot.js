// bot.js — Thin-Liquidity SCALP Bot for Solana (Telegram-controlled)
// Paste this entire file in Replit as bot.js. Secrets are loaded from Replit Secrets (env vars).

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

// -------------------- ENV (read from Replit Secrets) --------------------
const {
  RPC_URL = 'https://api.mainnet-beta.solana.com',
  WALLET_PRIVATE_KEY_BASE58,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ALLOWED_USER_ID,
  MAX_SLIPPAGE_BPS = '300',
  DEFAULT_BUY_SOL = '0.05',
  POLL_SECONDS = '10',

  // Thin-liquidity tuning (safe defaults)
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

// -------------------- SAFETY / CHECKS --------------------
if (!WALLET_PRIVATE_KEY_BASE58) {
  console.error('Missing WALLET_PRIVATE_KEY_BASE58 environment variable. Add it to Replit Secrets.');
  process.exit(1);
}
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ALLOWED_USER_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ALLOWED_USER_ID in environment.');
  process.exit(1);
}

// -------------------- Convert keypair (safe, no logging of secret) --------------------
let keypair;
try {
  const secretBytes = bs58.decode(WALLET_PRIVATE_KEY_BASE58);
  keypair = Keypair.fromSecretKey(Uint8Array.from(secretBytes));
} catch (err) {
  console.error('Failed to decode WALLET_PRIVATE_KEY_BASE58. Ensure it is a valid base58-encoded secret key.');
  process.exit(1);
}

// Log only the public key (safe)
console.log('Bot wallet public key:', keypair.publicKey.toBase58());

// -------------------- CONSTANTS --------------------
const connection = new Connection(RPC_URL, 'confirmed');
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Hard-coded SCALP triggers
const SCALP_TP_PCT = 20; // +20% take-profit
const SCALP_SL_PCT = 10; // -10% stop-loss

// Thin-liquidity numeric casts
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

// -------------------- AUTH --------------------
function allowed(ctx) {
  return String(ctx.from?.id) === String(TELEGRAM_ALLOWED_USER_ID);
}

// -------------------- PERSISTENCE --------------------
const POSITIONS_FILE = './positions.json';
function loadPositions() {
  try {
    if (!fs.existsSync(POSITIONS_FILE)) return {};
    return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}
function savePositions() {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}
let positions = loadPositions(); // keyed by mint
let lastChatId = null; // stored when allowed user messages bot

// -------------------- JUPITER HELPERS --------------------
async function jupQuote({ inputMint, outputMint, amountRaw, slippageBps }) {
  const url = new URL('https://quote-api.jup.ag/v6/quote');
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amountRaw));
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('onlyDirectRoutes', 'false');
  const r = await fetch(url);
  if (!r.ok) throw new Error('Quote failed');
  const data = await r.json();
  if (!data?.data?.[0]) throw new Error('No route');
  return data.data[0];
}

async function jupBuildAndSend({ quoteResponse }) {
  const res = await fetch('https://quote-api.jup.ag/v6/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true
    })
  });
  if (!res.ok) throw new Error('Swap build failed');
  const { swapTransaction } = await res.json();
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

    const route = await jupQuote({
      inputMint: WSOL_MINT,
      outputMint: mint,
      amountRaw: lamports,
      slippageBps: curSlip
    });
    const impact = extractImpactPct(route);

    if (!Number.isNaN(impact) && impact > THIN.HARD_IMPACT) {
      if (proposedSol <= THIN.MIN_SHARD_SOL + 1e-9) {
        throw new Error(`Price impact too high (${impact.toFixed(2)}%). Aborting buy.`);
      }
      remainingSol = Math.max(remainingSol - proposedSol / 2, 0);
      continue;
    }

    if (!Number.isNaN(impact) && impact > THIN.TARGET_IMPACT && proposedSol > THIN.MIN_SHARD_SOL) {
      const smallerSol = Math.max(proposedSol / 2, THIN.MIN_SHARD_SOL);
      const smallerLamports = Math.floor(smallerSol * 1e9);
      const smallerRoute = await jupQuote({
        inputMint: WSOL_MINT,
        outputMint: mint,
        amountRaw: smallerLamports,
        slippageBps: curSlip
      });
      const smallerImpact = extractImpactPct(smallerRoute);

      if (!Number.isNaN(smallerImpact) && smallerImpact <= impact) {
        const sig = await jupBuildAndSend({ quoteResponse: smallerRoute });
        spentLamports += BigInt(smallerRoute.inAmount || smallerLamports);
        receivedRaw   += BigInt(smallerRoute.outAmount);
        remainingSol  -= smallerSol;
        shards++;
        await new Promise(r => setTimeout(r, THIN.SHARD_DELAY_MS));
        continue;
      }
    }

    const sig = await jupBuildAndSend({ quoteResponse: route });
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

    const sig = await jupBuildAndSend({ quoteResponse: route });
    soldLamports += BigInt(route.outAmount);
    remaining    -= BigInt(route.inAmount || slice);

    await new Promise(r => setTimeout(r, THIN.EXIT_DELAY_MS));
  }

  return { sig: '(multiple shards)', outLamports: soldLamports };
}

// -------------------- TELEGRAM COMMANDS --------------------
bot.start((ctx) => {
  if (!allowed(ctx)) return ctx.reply('Not authorized.');
  lastChatId = ctx.chat?.id || lastChatId;
  ctx.reply(
`Ready. Commands:
/bal
/buy <mint> [sol]
/sell <mint> [percent]
/autobuy <mint> [sol]   (SCALP: TP +${SCALP_TP_PCT}%, SL -${SCALP_SL_PCT}% — thin-liq slicing)
/status
/cancel <mint>

Wallet: ${keypair.publicKey.toBase58()}`
  );
});

bot.on('message', (ctx) => {
  if (allowed(ctx)) lastChatId = ctx.chat?.id || lastChatId;
});

bot.command('bal', async (ctx) => {
  if (!allowed(ctx)) return ctx.reply('Not authorized.');
  const bal = await connection.getBalance(keypair.publicKey);
  ctx.reply(`SOL: ${(bal/1e9).toFixed(4)} — ${keypair.publicKey.toBase58()}`);
});

bot.command('buy', async (ctx) => {
  if (!allowed(ctx)) return ctx.reply('Not authorized.');
  const [, mint, solStr] = ctx.message.text.trim().split(/\s+/);
  const amountSol = solStr ?? DEFAULT_BUY_SOL;
  if (!mint) return ctx.reply('Usage: /buy <mint> [sol]');
  const sol = Number(amountSol);
  if (isNaN(sol) || sol <= 0) return ctx.reply('Invalid SOL amount.');
  try {
    await verifyMintExists(mint);
    const { outAmountRaw, totalSpentLamports, shardsExecuted } = await buyBySol({
      mint,
      amountSol: sol,
      slippageBps: THIN.SLIPPAGE_BASE
    });
    ctx.reply(
`Bought ${(Number(totalSpentLamports)/1e9).toFixed(6)} SOL of ${mint}
Received (raw): ${outAmountRaw}
Shards: ${shardsExecuted}`
    );
  } catch (e) {
    ctx.reply(`Buy failed: ${e.message}`);
  }
});

bot.command('sell', async (ctx) => {
  if (!allowed(ctx)) return ctx.reply('Not authorized.');
  const [, mint, pctStr] = ctx.message.text.trim().split(/\s+/);
  const pct = Number(pctStr ?? '100');
  if (!mint || isNaN(pct) || pct <= 0 || pct > 100) return ctx.reply('Usage: /sell <mint> [percent 1-100]');
  try {
    const raw = await getTokenRawBalance(mint);
    if (raw <= 0n) throw new Error('No balance');
    const toSell = (raw * BigInt(Math.floor(pct))) / 100n;
    const { outLamports } = await sellTokensForSol({
      mint,
      amountRaw: toSell,
      slippageBps: THIN.SLIPPAGE_BASE
    });
    ctx.reply(`Sold ${pct}% — received ~${(Number(outLamports)/1e9).toFixed(6)} SOL`);
  } catch (e) {
    ctx.reply(`Sell failed: ${e.message}`);
  }
});

bot.command('autobuy', async (ctx) => {
  if (!allowed(ctx)) return ctx.reply('Not authorized.');
  const parts = ctx.message.text.trim().split(/\s+/);
  const mint = parts[1];
  const solStr = parts[2] || DEFAULT_BUY_SOL;

  if (!mint) {
    return ctx.reply(
`Usage:
  /autobuy <mint> [sol]

Profile: SCALP (thin-liquidity)
  TP: +${SCALP_TP_PCT}% | SL: -${SCALP_SL_PCT}%
  Buy shards: up to ${THIN.MAX_SHARDS} (>= ${THIN.MIN_SHARD_SOL} SOL each)
  Target impact: ≤ ${THIN.TARGET_IMPACT}% (hard stop at ${THIN.HARD_IMPACT}%)`
    );
  }

  const sol = Number(solStr);
  if (isNaN(sol) || sol <= 0) return ctx.reply('Invalid SOL amount.');

  try {
    await verifyMintExists(mint);

    const { outAmountRaw, totalSpentLamports, shardsExecuted } = await buyBySol({
      mint,
      amountSol: sol,
      slippageBps: THIN.SLIPPAGE_BASE
    });

    positions[mint] = {
      mint,
      entrySolSpent: Number(totalSpentLamports) / 1e9,
      entryTokenRecvRaw: outAmountRaw.toString(),
      tpPct: SCALP_TP_PCT,
      slPct: SCALP_SL_PCT,
      createdAt: new Date().toISOString(),
      lastCheck: null,
      profileUsed: 'SCALP-THIN',
      tookPartialTP: false
    };
    savePositions();

    ctx.reply(
`Auto-buy ✅ (thin-liq SCALP)
Mint: ${mint}
Spent: ${(Number(totalSpentLamports)/1e9).toFixed(6)} SOL
Received (raw): ${outAmountRaw}
Shards: ${shardsExecuted}
TP: +${SCALP_TP_PCT}% | SL: -${SCALP_SL_PCT}%`
    );
  } catch (e) {
    ctx.reply(`Autobuy failed: ${e.message}`);
  }
});

bot.command('status', async (ctx) => {
  if (!allowed(ctx)) return ctx.reply('Not authorized.');
  if (!Object.keys(positions).length) return ctx.reply('No active positions.');
  let msg = 'Active positions:\n';
  for (const p of Object.values(positions)) {
    msg += `\n• ${p.mint}
  Entry: ${p.entrySolSpent} SOL for ${p.entryTokenRecvRaw} raw
  TP: +${p.tpPct}% | SL: -${p.slPct}%  (Profile: ${p.profileUsed})
  Partial TP taken: ${p.tookPartialTP ? 'Yes' : 'No'}
  Since: ${p.createdAt}\n`;
  }
  ctx.reply(msg);
});

bot.command('cancel', async (ctx) => {
  if (!allowed(ctx)) return ctx.reply('Not authorized.');
  const [, mint] = ctx.message.text.trim().split(/\s+/);
  if (!mint) return ctx.reply('Usage: /cancel <mint>');
  if (!positions[mint]) return ctx.reply('No such position.');
  delete positions[mint];
  savePositions();
  ctx.reply(`Canceled monitoring for ${mint}. (No auto-sell will trigger.)`);
});

// -------------------- MONITOR LOOP: TP/SL --------------------
async function monitorPositions() {
  const now = new Date().toISOString();
  for (const mint of Object.keys(positions)) {
    try {
      const p = positions[mint];
      const tokenBalRaw = await getTokenRawBalance(mint);
      if (tokenBalRaw <= 0n) {
        delete positions[mint];
        savePositions();
        continue;
      }

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
        const { outLamports } = await sellTokensForSol({
          mint,
          amountRaw: tokenBalRaw,
          slippageBps: THIN.SLIPPAGE_BASE
        });
        if (lastChatId) {
          bot.telegram.sendMessage(lastChatId,
            `🔻 Stop-loss hit for ${mint} at ~${pnlPct.toFixed(2)}%\nExited ~${(Number(outLamports)/1e9).toFixed(6)} SOL.`);
        }
        delete positions[mint];
        savePositions();
        continue;
      }

      if (hitTP) {
        if (!p.tookPartialTP) {
          const toSell = tokenBalRaw / 2n;
          if (toSell > 0n) {
            const { outLamports } = await sellTokensForSol({
              mint,
              amountRaw: toSell,
              slippageBps: THIN.SLIPPAGE_BASE
            });
            positions[mint].slPct = 0;
            positions[mint].tookPartialTP = true;
            savePositions();

            if (lastChatId) {
              bot.telegram.sendMessage(lastChatId,
                `✅ Partial TP for ${mint} at ~${pnlPct.toFixed(2)}%\nSold 50%, moved SL to breakeven.\nRealized ~${(Number(outLamports)/1e9).toFixed(6)} SOL.`);
            }
          }
          continue;
        } else {
          const { outLamports } = await sellTokensForSol({
            mint,
            amountRaw: tokenBalRaw,
            slippageBps: THIN.SLIPPAGE_BASE
          });
          if (lastChatId) {
            bot.telegram.sendMessage(lastChatId,
              `🏁 Final TP exit for ${mint} at ~${pnlPct.toFixed(2)}%\nExited remaining for ~${(Number(outLamports)/1e9).toFixed(6)} SOL.`);
          }
          delete positions[mint];
          savePositions();
          continue;
        }
      }

    } catch (err) {
      console.error('[Monitor error]', mint, err.message);
    }
  }
}

setInterval(monitorPositions, Number(POLL_SECONDS) * 1000);

// -------------------- START --------------------
bot.launch().then(() => {
  console.log(`Bot running. Wallet: ${keypair.publicKey.toBase58()}`);
});
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
