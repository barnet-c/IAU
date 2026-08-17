/**
 * lib/discord.js
 * Discord notification module for ARKB Arb — sends alerts to a channel or DM.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let Client;
let GatewayIntentBits;
let EmbedBuilder;
try {
  ({ Client, GatewayIntentBits, EmbedBuilder } = require('discord.js'));
} catch {
  // optional dependency path for stripped environments
}

const TOKEN = process.env.DISCORD_TOKEN;
const USER_ID = process.env.DISCORD_USER_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

let client = null;
let ready = false;
let alertChannelId = null;
let creationUnitShares = 5000;

function setContext({ creationUnitShares: cu } = {}) {
  if (Number.isFinite(cu) && cu > 0) creationUnitShares = cu;
}

async function init(context = {}) {
  setContext(context);

  if (!TOKEN) {
    console.warn('[Discord] No DISCORD_TOKEN set — alerts disabled');
    return false;
  }
  if (!Client) {
    console.warn('[Discord] discord.js not available — alerts disabled');
    return false;
  }
  if (client) return true;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.once('clientReady', async () => {
    // discord.js v14 used 'ready'; v15 uses 'clientReady' — handle both below too
  });

  const onReady = async () => {
    console.log(`[Discord] Logged in as ${client.user.tag}`);
    ready = true;

    if (!GUILD_ID) {
      console.warn('[Discord] DISCORD_GUILD_ID not set — channel alerts disabled (DM still available)');
      return;
    }

    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const channels = await guild.channels.fetch();
      let channel = channels.find((c) => c && c.name === 'arkb-arb-alerts' && c.isTextBased && c.isTextBased());
      if (!channel) {
        channel = await guild.channels.create({
          name: 'arkb-arb-alerts',
          topic: 'ARKB ETF arbitrage signals — creation/redemption arb vs BTC NAV',
        });
        console.log('[Discord] Created #arkb-arb-alerts channel');
      }
      alertChannelId = channel.id;
      console.log(`[Discord] Alert channel: #${channel.name} (${channel.id})`);

      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf7931a)
            .setTitle('🟠 ARKB Arb Bot Online')
            .setDescription('Dashboard is live. Monitoring ARKB premium/discount arb signals.')
            .setTimestamp(),
        ],
      });
    } catch (e) {
      console.error(`[Discord] Channel setup error: ${e.message}`);
    }
  };

  client.once('ready', onReady);
  client.once('clientReady', onReady);
  client.on('error', (e) => console.error(`[Discord] Error: ${e.message}`));

  await client.login(TOKEN);
  return true;
}

async function getChannel() {
  if (!ready || !alertChannelId || !client) return null;
  try {
    return await client.channels.fetch(alertChannelId);
  } catch {
    return null;
  }
}

async function sendTradeAlert(trade) {
  const channel = await getChannel();
  if (!channel || !EmbedBuilder) return;

  const isCreate = trade.signal === 'CREATE';
  const color = isCreate ? 0x3fb950 : 0xf85149;
  const emoji = isCreate ? '🟢' : '🔴';
  const cu = creationUnitShares.toLocaleString('en-US');

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji} ARKB ARB SIGNAL — ${trade.signal}`)
    .setDescription(
      isCreate
        ? 'ETF trading at **premium** → Buy BTC → Deliver to Coinbase Custody → Receive ARKB → Sell'
        : 'ETF trading at **discount** → Buy ARKB → Redeem for BTC → Sell BTC'
    )
    .addFields(
      { name: 'ARKB Price', value: `$${Number(trade.arkbPrice).toFixed(4)}`, inline: true },
      { name: 'BTC Price', value: `$${Number(trade.btcPrice).toFixed(2)}`, inline: true },
      { name: 'NAV Estimate', value: `$${Number(trade.navEstimate).toFixed(4)}`, inline: true },
      { name: 'Spread (bps)', value: `${Number(trade.spreadBps).toFixed(2)} bps`, inline: true },
      { name: 'Est. P&L', value: `$${Number(trade.pnl).toFixed(2)}`, inline: true },
      { name: 'Unit Size', value: `${cu} shares`, inline: true }
    )
    .setTimestamp(new Date(trade.timestamp))
    .setFooter({ text: 'ARKB Arb Dashboard — ARK 21Shares Bitcoin ETF' });

  await channel.send({ embeds: [embed] });
}

async function sendDM(message) {
  if (!ready || !USER_ID || !client) return;
  try {
    const user = await client.users.fetch(USER_ID);
    await user.send(message);
  } catch (e) {
    console.error(`[Discord] DM error: ${e.message}`);
  }
}

module.exports = { init, sendTradeAlert, sendDM, setContext };
