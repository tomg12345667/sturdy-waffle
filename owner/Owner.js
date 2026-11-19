// /owner — the bot owner's private dashboard.
// Registered only in the owner's home server (config.json "ownerGuildId") and only answers
// the bot's owner (the Developer Portal app owner / team members, or config.json "ownerIds").
const {
    SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, version: djsVersion,
} = require('discord.js');
const sqlite3 = require('sqlite3');
const errorLog = require('../errorLog');

const COLOR = 0xFFC861;
const PAGE_SIZE = 10;
const EVENTS = ['channelCreate','channelDelete','channelUpdate','guildBanAdd','guildBanRemove','guildEmojiCreate','guildEmojiDelete','guildEmojiUpdate','guildInviteCreate','guildMemberAdd','guildMemberRemove','guildMemberOnboarding','guildMemberUpdate','guildRoleCreate','guildRoleDelete','guildRoleUpdate','guildStickerCreate','guildStickerDelete','guildStickerUpdate','guildUpdate','messageBulkDelete','messageDelete','messageDeleteAttachments','messageUpdate','voiceStateUpdate'];

// ---------- database helpers ----------
function openDb() {
    return new sqlite3.Database('./config.db', (err) => { if (err) console.log(err); });
}
function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        const db = openDb();
        db.all(sql, params, (err, rows) => { db.close(); err ? reject(err) : resolve(rows); });
    });
}
function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        const db = openDb();
        db.run(sql, params, function (err) { db.close(); err ? reject(err) : resolve(this.changes); });
    });
}
const isId = (s) => /^\d{17,20}$/.test(s || '');

async function getSettings(guildId) {
    if (!isId(guildId)) return null;
    try {
        const rows = await all(`SELECT * FROM "${guildId}" LIMIT 1`);
        return rows[0] || null;
    } catch { return null; }
}
async function configuredGuildIds() {
    const tables = await all(`SELECT name FROM sqlite_master WHERE type='table'`);
    const ids = new Set();
    for (const t of tables) {
        if (!isId(t.name)) continue;
        if (await getSettings(t.name)) ids.add(t.name);
    }
    return ids;
}
async function setLogChannel(guildId, channelId) {
    await run(`CREATE TABLE IF NOT EXISTS "${guildId}" (logChannel text, ${EVENTS.map(e => `${e} integer`).join(', ')})`);
    if (await getSettings(guildId)) {
        await run(`UPDATE "${guildId}" SET logChannel = ?`, [channelId]);
        return 'updated';
    }
    await run(`INSERT INTO "${guildId}" (logChannel, ${EVENTS.join(', ')}) VALUES (?, ${EVENTS.map(() => '1').join(', ')})`, [channelId]);
    return 'created';
}
async function setEvents(guildId, events, on) {
    await run(`UPDATE "${guildId}" SET ${events.map(e => `${e} = ?`).join(', ')}`, events.map(() => (on ? 1 : 0)));
}

// ---------- formatting helpers ----------
function duration(ms) {
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const reply = (i, payload) => i.reply({ ...payload, flags: MessageFlags.Ephemeral });

// ---------- owner check ----------
let ownerCache = null;
async function ownerIds(client) {
    if (ownerCache) return ownerCache;
    const ids = new Set();
    try {
        const { ownerIds: configured } = require('../config.json');
        (configured || []).forEach(id => ids.add(String(id)));
    } catch { /* no config entry */ }
    if (!client.application.owner) await client.application.fetch();
    const owner = client.application.owner;
    if (owner?.members) owner.members.forEach(m => ids.add(m.id)); // team
    else if (owner?.id) ids.add(owner.id);
    ownerCache = ids;
    return ids;
}

function findGuild(client, id) {
    return isId(id) ? client.guilds.cache.get(id) : null;
}

// ---------- subcommands ----------
async function stats(i) {
    const c = i.client;
    const guilds = [...c.guilds.cache.values()];
    const members = guilds.reduce((n, g) => n + (g.memberCount || 0), 0);
    const configured = await configuredGuildIds();
    const mem = process.memoryUsage();
    const embed = new EmbedBuilder().setColor(COLOR).setTitle('Logwarden — stats')
        .addFields(
            { name: 'Servers', value: `${guilds.length}`, inline: true },
            { name: 'Set up', value: `${[...configured].filter(id => c.guilds.cache.has(id)).length}`, inline: true },
            { name: 'Members', value: members.toLocaleString(), inline: true },
            { name: 'Uptime', value: duration(process.uptime() * 1000), inline: true },
            { name: 'Ping', value: `${c.ws.ping} ms`, inline: true },
            { name: 'Memory', value: `${mb(mem.rss)} (heap ${mb(mem.heapUsed)})`, inline: true },
            { name: 'Errors since start', value: `${errorLog.countSinceStart()}`, inline: true },
            { name: 'Versions', value: `Node ${process.version} · discord.js ${djsVersion}`, inline: true },
        )
        .setTimestamp();
    return reply(i, { embeds: [embed] });
}

async function servers(i) {
    const configured = await configuredGuildIds();
    const list = [...i.client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const page = Math.min(Math.max(1, i.options.getInteger('page') || 1), pages);
    const lines = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(g =>
        `${configured.has(g.id) ? '✅' : '⚪'} **${cut(g.name, 40)}** · ${g.memberCount.toLocaleString()} members\n \`${g.id}\``);
    const embed = new EmbedBuilder().setColor(COLOR)
        .setTitle(`Servers (${list.length})`)
        .setDescription(lines.join('\n') || 'The bot is not in any servers.')
        .setFooter({ text: `Page ${page} of ${pages} · ✅ set up  ⚪ not set up · /owner server for details` });
    return reply(i, { embeds: [embed] });
}

async function server(i) {
    const g = findGuild(i.client, i.options.getString('server'));
    if (!g) return reply(i, { content: 'The bot isn\'t in that server.' });
    const s = await getSettings(g.id);
    const me = g.members.me;
    const fields = [
        { name: 'Owner', value: `<@${g.ownerId}> \`${g.ownerId}\``, inline: true },
        { name: 'Members', value: g.memberCount.toLocaleString(), inline: true },
        { name: 'Added', value: me?.joinedTimestamp ? ts(me.joinedTimestamp) : 'unknown', inline: true },
        { name: 'Created', value: ts(g.createdTimestamp, 'D'), inline: true },
        { name: 'View Audit Log', value: me?.permissions.has(PermissionFlagsBits.ViewAuditLog) ? '✅' : '❌ missing', inline: true },
    ];
    if (!s) {
        fields.push({ name: 'Logging', value: '⚪ Not set up (no /setchannel yet). Use `/owner setchannel` to set it.' });
    } else {
        const ch = g.channels.cache.get(s.logChannel);
        let chText = `<#${s.logChannel}> \`${s.logChannel}\``;
        if (!ch) chText += '\n❌ Channel no longer exists';
        else {
            const p = ch.permissionsFor(me);
            const missing = [['ViewChannel', 'View'], ['SendMessages', 'Send'], ['EmbedLinks', 'Embed'], ['AttachFiles', 'Attach']]
                .filter(([flag]) => !p?.has(PermissionFlagsBits[flag])).map(([, n]) => n);
            chText += missing.length ? `\n❌ Missing: ${missing.join(', ')}` : '\n✅ Bot can post here';
        }
        const on = EVENTS.filter(e => s[e] === 1 || s[e] === '1' || s[e] === 'true');
        const off = EVENTS.filter(e => !on.includes(e));
        fields.push(
            { name: 'Log channel', value: chText },
            { name: `Events on (${on.length}/${EVENTS.length})`, value: cut(on.join(', ') || 'none', 1024) },
            { name: `Events off (${off.length})`, value: cut(off.join(', ') || 'none', 1024) },
        );
    }
    const embed = new EmbedBuilder().setColor(COLOR).setTitle(cut(g.name, 250)).setDescription(`\`${g.id}\``).addFields(fields);
    if (g.iconURL()) embed.setThumbnail(g.iconURL());
    return reply(i, { embeds: [embed] });
}

async function leave(i) {
    const g = findGuild(i.client, i.options.getString('server'));
    if (!g) return reply(i, { content: 'The bot isn\'t in that server.' });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('owner-leave-yes').setLabel(`Leave ${cut(g.name, 60)}`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('owner-leave-no').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    const res = await i.reply({
        content: `Leave **${g.name}** (${g.memberCount.toLocaleString()} members)? Its settings will be deleted. They can add the bot again later.`,
        components: [row], flags: MessageFlags.Ephemeral, withResponse: true,
    });
    const msg = res.resource.message;
    try {
        const btn = await msg.awaitMessageComponent({ filter: b => b.user.id === i.user.id, time: 30_000 });
        if (btn.customId !== 'owner-leave-yes') return btn.update({ content: 'Cancelled.', components: [] });
        const name = g.name;
        await g.leave();
        return btn.update({ content: `Left **${name}** and deleted its settings.`, components: [] });
    } catch (e) {
        if (e?.code === 'InteractionCollectorError' || /time/i.test(e?.message || '')) {
            return i.editReply({ content: 'Timed out, nothing changed.', components: [] });
        }
        throw e;
    }
}

async function setchannel(i) {
    const g = findGuild(i.client, i.options.getString('server'));
    if (!g) return reply(i, { content: 'The bot isn\'t in that server.' });
    const ch = g.channels.cache.get(i.options.getString('channel'));
    if (!ch || !ch.isTextBased() || ch.isThread()) return reply(i, { content: 'That isn\'t a text channel in that server. Pick one from the list.' });
    const result = await setLogChannel(g.id, ch.id);
    const p = ch.permissionsFor(g.members.me);
    const missing = [['ViewChannel', 'View Channel'], ['SendMessages', 'Send Messages'], ['EmbedLinks', 'Embed Links']]
        .filter(([flag]) => !p?.has(PermissionFlagsBits[flag])).map(([, n]) => n);
    let content = `Log channel for **${g.name}** is now **#${ch.name}**` + (result === 'created' ? ' (set up with every event on).' : '.');
    if (missing.length) content += `\n⚠️ The bot is missing ${missing.join(', ')} there, so logs won't post until that's fixed.`;
    return reply(i, { content });
}

async function event(i) {
    const g = findGuild(i.client, i.options.getString('server'));
    if (!g) return reply(i, { content: 'The bot isn\'t in that server.' });
    if (!(await getSettings(g.id))) return reply(i, { content: `**${g.name}** isn't set up yet. Use \`/owner setchannel\` first.` });
    const name = i.options.getString('event');
    const on = i.options.getBoolean('on');
    const events = name === 'all' ? EVENTS : EVENTS.includes(name) ? [name] : null;
    if (!events) return reply(i, { content: `Unknown event \`${cut(name, 50)}\`. Pick one from the list.` });
    await setEvents(g.id, events, on);
    return reply(i, { content: `${name === 'all' ? 'All events' : `\`${name}\``} turned **${on ? 'on' : 'off'}** for **${g.name}**.` });
}

async function errors(i) {
    if (i.options.getBoolean('clear')) {
        errorLog.clear();
        return reply(i, { content: 'Error list cleared.' });
    }
    const list = errorLog.recent(8);
    if (!list.length) return reply(i, { content: 'No errors recorded. 🎉' });
    const embed = new EmbedBuilder().setColor(0xFF8A3D)
        .setTitle(`Recent errors (latest ${list.length} of ${errorLog.total()})`)
        .setDescription(list.map(e => {
            const where = e.guildId ? ` · server \`${e.guildId}\`` : '';
            return `${ts(e.at)} · ${e.source}${where}\n\`\`\`\n${cut(e.text.replace(/```/g, "'''"), 380)}\n\`\`\``;
        }).join('\n').slice(0, 4000))
        .setFooter({ text: 'Saved across restarts · /owner errors clear:true to reset' });
    return reply(i, { embeds: [embed] });
}

const handlers = { stats, servers, server, leave, setchannel, event, errors };

// ---------- command definition ----------
const serverOpt = (o) => o.setName('server').setDescription('Server (type to search)').setRequired(true).setAutocomplete(true);

module.exports = {
    ownerOnly: true,
    data: new SlashCommandBuilder()
        .setName('owner')
        .setDescription('Bot owner dashboard')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false)
        .addSubcommand(s => s.setName('stats').setDescription('Bot stats: servers, members, uptime, memory'))
        .addSubcommand(s => s.setName('servers').setDescription('Every server the bot is in')
            .addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1)))
        .addSubcommand(s => s.setName('server').setDescription('Details and settings for one server').addStringOption(serverOpt))
        .addSubcommand(s => s.setName('leave').setDescription('Make the bot leave a server').addStringOption(serverOpt))
        .addSubcommand(s => s.setName('setchannel').setDescription('Set a server\'s log channel')
            .addStringOption(serverOpt)
            .addStringOption(o => o.setName('channel').setDescription('Channel (pick a server first)').setRequired(true).setAutocomplete(true)))
        .addSubcommand(s => s.setName('event').setDescription('Turn an event on or off for a server')
            .addStringOption(serverOpt)
            .addStringOption(o => o.setName('event').setDescription('Event, or "all"').setRequired(true).setAutocomplete(true))
            .addBooleanOption(o => o.setName('on').setDescription('On or off').setRequired(true)))
        .addSubcommand(s => s.setName('errors').setDescription('The bot\'s recent errors')
            .addBooleanOption(o => o.setName('clear').setDescription('Clear the list'))),

    execute: async function (interaction) {
        if (!(await ownerIds(interaction.client)).has(interaction.user.id)) {
            return reply(interaction, { content: 'This command is only for the bot\'s owner.' });
        }
        return handlers[interaction.options.getSubcommand()](interaction);
    },

    autocomplete: async function (interaction) {
        if (!(await ownerIds(interaction.client)).has(interaction.user.id)) return interaction.respond([]);
        const focused = interaction.options.getFocused(true);
        const q = String(focused.value || '').toLowerCase();
        let choices = [];
        if (focused.name === 'server') {
            choices = [...interaction.client.guilds.cache.values()]
                .filter(g => g.name.toLowerCase().includes(q) || g.id.includes(q))
                .sort((a, b) => b.memberCount - a.memberCount)
                .map(g => ({ name: cut(`${g.name} · ${g.memberCount} members`, 100), value: g.id }));
        } else if (focused.name === 'channel') {
            const g = findGuild(interaction.client, interaction.options.getString('server'));
            if (g) choices = [...g.channels.cache.values()]
                .filter(c => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase().includes(q))
                .sort((a, b) => a.rawPosition - b.rawPosition)
                .map(c => ({ name: cut(`#${c.name}`, 100), value: c.id }));
        } else if (focused.name === 'event') {
            choices = ['all', ...EVENTS].filter(e => e.toLowerCase().includes(q)).map(e => ({ name: e, value: e }));
        }
        return interaction.respond(choices.slice(0, 25));
    },
};
