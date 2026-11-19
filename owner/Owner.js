// /owner — the bot owner's private dashboard.
// Registered only in the owner's home server (config.json "ownerGuildId") and only answers
// the bot's owner (the Developer Portal app owner / team members, or config.json "ownerIds").
//
// Anything that changes a server (setchannel, event, restore, leave, blacklist) asks first
// whether to notify that server's owner. Changing a server's settings puts it into
// "maintenance": its original settings are saved, and /owner restore puts them back.
const {
    SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, version: djsVersion,
} = require('discord.js');
const sqlite3 = require('sqlite3');
const errorLog = require('../errorLog');

const COLOR = 0xFFC861;
const WARN = 0xFF8A3D;
const GOOD = 0x57F287;
const PAGE_SIZE = 10;
const CONFIRM_MS = 60_000;
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

// Bot-wide tables. Their names start with "_" so they never clash with a server's table.
let ready = null;
function ensureTables() {
    if (!ready) ready = (async () => {
        await run(`CREATE TABLE IF NOT EXISTS _snapshots (guildId TEXT PRIMARY KEY, settings TEXT, takenAt INTEGER)`);
        await run(`CREATE TABLE IF NOT EXISTS _blacklist (id TEXT PRIMARY KEY, kind TEXT, reason TEXT, addedAt INTEGER)`);
    })();
    return ready;
}

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
const createTableSql = (guildId) => `CREATE TABLE IF NOT EXISTS "${guildId}" (logChannel text, ${EVENTS.map(e => `${e} integer`).join(', ')})`;

async function setLogChannel(guildId, channelId) {
    await run(createTableSql(guildId));
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

// ----- maintenance snapshots -----
async function getSnapshot(guildId) {
    await ensureTables();
    const rows = await all(`SELECT * FROM _snapshots WHERE guildId = ?`, [guildId]);
    if (!rows[0]) return null;
    return { settings: JSON.parse(rows[0].settings), takenAt: rows[0].takenAt };
}
// Saves the server's current settings, unless they were already saved. Returns true if this
// started a new maintenance period.
async function takeSnapshot(guildId) {
    await ensureTables();
    if (await getSnapshot(guildId)) return false;
    const settings = await getSettings(guildId); // null = server wasn't set up
    await run(`INSERT INTO _snapshots (guildId, settings, takenAt) VALUES (?, ?, ?)`, [guildId, JSON.stringify(settings), Date.now()]);
    return true;
}
async function restoreSnapshot(guildId) {
    const snap = await getSnapshot(guildId);
    if (!snap) return false;
    if (!snap.settings) {
        await run(`DROP TABLE IF EXISTS "${guildId}"`);
    } else {
        await run(createTableSql(guildId));
        await run(`DELETE FROM "${guildId}"`);
        const cols = ['logChannel', ...EVENTS];
        await run(`INSERT INTO "${guildId}" (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            cols.map(c => snap.settings[c] ?? null));
    }
    await run(`DELETE FROM _snapshots WHERE guildId = ?`, [guildId]);
    return true;
}
async function maintenanceIds() {
    await ensureTables();
    return new Set((await all(`SELECT guildId FROM _snapshots`)).map(r => r.guildId));
}

// ----- blacklist -----
async function blacklistGet(ids) {
    await ensureTables();
    const list = ids.filter(Boolean);
    if (!list.length) return null;
    const rows = await all(`SELECT * FROM _blacklist WHERE id IN (${list.map(() => '?').join(', ')})`, list);
    return rows[0] || null;
}
async function blacklistAdd(id, kind, reason) {
    await ensureTables();
    await run(`INSERT OR REPLACE INTO _blacklist (id, kind, reason, addedAt) VALUES (?, ?, ?, ?)`, [id, kind, reason || null, Date.now()]);
}
async function blacklistRemove(id) {
    await ensureTables();
    return run(`DELETE FROM _blacklist WHERE id = ?`, [id]);
}
async function blacklistAll() {
    await ensureTables();
    return all(`SELECT * FROM _blacklist ORDER BY addedAt DESC`);
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

// ---------- notifying a server's owner ----------
const notices = {
    maintenance: (g) => new EmbedBuilder().setColor(COLOR).setTitle('🛠 Logwarden maintenance')
        .setDescription(`Maintenance is ongoing on Logwarden's settings for **${g.name}**.\n\nYour current Logwarden settings have been saved. Once maintenance is complete, they will be restored. You don't need to do anything.`)
        .setFooter({ text: 'Message from the Logwarden bot owner' }).setTimestamp(),
    restored: (g) => new EmbedBuilder().setColor(GOOD).setTitle('✅ Logwarden maintenance complete')
        .setDescription(`Maintenance on Logwarden for **${g.name}** is complete, and your saved settings have been restored.`)
        .setFooter({ text: 'Message from the Logwarden bot owner' }).setTimestamp(),
    left: (g, reason) => new EmbedBuilder().setColor(WARN).setTitle('Logwarden has left your server')
        .setDescription(`Logwarden was removed from **${g.name}** by the bot's owner, and its settings for your server have been deleted.` +
            (reason ? `\n\n**Reason:** ${reason}` : ''))
        .setFooter({ text: 'Message from the Logwarden bot owner' }).setTimestamp(),
    blacklisted: (g, reason, kind) => new EmbedBuilder().setColor(WARN).setTitle('Logwarden: blacklisted')
        .setDescription((kind === 'user'
            ? `You have been blacklisted from using Logwarden, so it has left **${g.name}** and its settings there have been deleted. It will leave any server you add it to.`
            : `**${g.name}** has been blacklisted from using Logwarden, so the bot has left and its settings have been deleted. It will leave if it is added again.`) +
            (reason ? `\n\n**Reason:** ${reason}` : ''))
        .setFooter({ text: 'Message from the Logwarden bot owner' }).setTimestamp(),
};

// DMs the server's owner. If their DMs are closed, falls back to the server's log channel.
async function notifyServerOwner(guild, embed) {
    try {
        const user = await guild.client.users.fetch(guild.ownerId);
        await user.send({ embeds: [embed] });
        return `📨 Server owner notified by DM.`;
    } catch { /* DMs closed or user not reachable */ }
    try {
        const s = await getSettings(guild.id);
        const ch = s && guild.channels.cache.get(s.logChannel);
        if (ch) {
            await ch.send({ content: `<@${guild.ownerId}>`, embeds: [embed], allowedMentions: { users: [guild.ownerId] } });
            return `📨 Owner's DMs are closed, so the notice was posted in #${ch.name}.`;
        }
    } catch { /* no permission */ }
    return `⚠️ Couldn't notify the server owner (DMs closed and no usable log channel).`;
}

// Shows "Do it & notify owner" / "Do it, don't notify" / "Cancel" buttons.
// Resolves to { notify: boolean, btn } or null if cancelled / timed out.
async function confirm(i, { content, action, danger = false }) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('notify').setLabel(cut(`${action} & notify owner`, 80)).setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('silent').setLabel(cut(`${action}, don't notify`, 80)).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    const res = await i.reply({ content, components: [row], flags: MessageFlags.Ephemeral, withResponse: true });
    let btn;
    try {
        btn = await res.resource.message.awaitMessageComponent({ filter: b => b.user.id === i.user.id, time: CONFIRM_MS });
    } catch {
        await i.editReply({ content: 'Timed out, nothing changed.', components: [] });
        return null;
    }
    if (btn.customId === 'cancel') {
        await btn.update({ content: 'Cancelled, nothing changed.', components: [] });
        return null;
    }
    await btn.deferUpdate();
    return { notify: btn.customId === 'notify', done: (text) => btn.editReply({ content: text, components: [] }) };
}

// ---------- subcommands ----------
async function stats(i) {
    const c = i.client;
    const guilds = [...c.guilds.cache.values()];
    const members = guilds.reduce((n, g) => n + (g.memberCount || 0), 0);
    const configured = await configuredGuildIds();
    const maint = await maintenanceIds();
    const black = await blacklistAll();
    const mem = process.memoryUsage();
    const embed = new EmbedBuilder().setColor(COLOR).setTitle('Logwarden — stats')
        .addFields(
            { name: 'Servers', value: `${guilds.length}`, inline: true },
            { name: 'Set up', value: `${[...configured].filter(id => c.guilds.cache.has(id)).length}`, inline: true },
            { name: 'Members', value: members.toLocaleString(), inline: true },
            { name: 'Under maintenance', value: `${[...maint].filter(id => c.guilds.cache.has(id)).length}`, inline: true },
            { name: 'Blacklisted', value: `${black.length}`, inline: true },
            { name: 'Errors since start', value: `${errorLog.countSinceStart()}`, inline: true },
            { name: 'Uptime', value: duration(process.uptime() * 1000), inline: true },
            { name: 'Ping', value: `${c.ws.ping} ms`, inline: true },
            { name: 'Memory', value: `${mb(mem.rss)} (heap ${mb(mem.heapUsed)})`, inline: true },
            { name: 'Versions', value: `Node ${process.version} · discord.js ${djsVersion}` },
        )
        .setTimestamp();
    return reply(i, { embeds: [embed] });
}

async function servers(i) {
    const configured = await configuredGuildIds();
    const maint = await maintenanceIds();
    const list = [...i.client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const page = Math.min(Math.max(1, i.options.getInteger('page') || 1), pages);
    const lines = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(g =>
        `${maint.has(g.id) ? '🛠' : configured.has(g.id) ? '✅' : '⚪'} **${cut(g.name, 40)}** · ${g.memberCount.toLocaleString()} members\n \`${g.id}\``);
    const embed = new EmbedBuilder().setColor(COLOR)
        .setTitle(`Servers (${list.length})`)
        .setDescription(lines.join('\n') || 'The bot is not in any servers.')
        .setFooter({ text: `Page ${page} of ${pages} · ✅ set up  ⚪ not set up  🛠 maintenance · /owner server for details` });
    return reply(i, { embeds: [embed] });
}

async function server(i) {
    const g = findGuild(i.client, i.options.getString('server'));
    if (!g) return reply(i, { content: 'The bot isn\'t in that server.' });
    const s = await getSettings(g.id);
    const snap = await getSnapshot(g.id);
    const me = g.members.me;
    const fields = [
        { name: 'Owner', value: `<@${g.ownerId}> \`${g.ownerId}\``, inline: true },
        { name: 'Members', value: g.memberCount.toLocaleString(), inline: true },
        { name: 'Added', value: me?.joinedTimestamp ? ts(me.joinedTimestamp) : 'unknown', inline: true },
        { name: 'Created', value: ts(g.createdTimestamp, 'D'), inline: true },
        { name: 'View Audit Log', value: me?.permissions.has(PermissionFlagsBits.ViewAuditLog) ? '✅' : '❌ missing', inline: true },
    ];
    if (snap) fields.push({ name: '🛠 Under maintenance', value: `Since ${ts(snap.takenAt)}. Original settings saved; \`/owner restore\` puts them back.` });
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

// Shared by setchannel and event: confirm, snapshot (start maintenance), apply, notify.
async function changeSettings(i, g, summary, apply) {
    const already = await getSnapshot(g.id);
    const c = await confirm(i, {
        content: `${summary}\n` + (already
            ? `🛠 **${g.name}** is already under maintenance; its original settings are saved.`
            : `🛠 This puts **${g.name}** under maintenance: its current settings are saved first, and \`/owner restore\` puts them back.`),
        action: 'Apply',
    });
    if (!c) return;
    await takeSnapshot(g.id);
    const result = await apply();
    const note = c.notify ? `\n${await notifyServerOwner(g, notices.maintenance(g))}` : '';
    return c.done(result + note);
}

async function setchannel(i) {
    const g = findGuild(i.client, i.options.getString('server'));
    if (!g) return reply(i, { content: 'The bot isn\'t in that server.' });
    const ch = g.channels.cache.get(i.options.getString('channel'));
    if (!ch || !ch.isTextBased() || ch.isThread()) return reply(i, { content: 'That isn\'t a text channel in that server. Pick one from the list.' });
    return changeSettings(i, g, `Set **${g.name}**'s log channel to **#${ch.name}**?`, async () => {
        const result = await setLogChannel(g.id, ch.id);
        const p = ch.permissionsFor(g.members.me);
        const missing = [['ViewChannel', 'View Channel'], ['SendMessages', 'Send Messages'], ['EmbedLinks', 'Embed Links']]
            .filter(([flag]) => !p?.has(PermissionFlagsBits[flag])).map(([, n]) => n);
        let text = `Log channel for **${g.name}** is now **#${ch.name}**` + (result === 'created' ? ' (set up with every event on).' : '.');
        if (missing.length) text += `\n⚠️ The bot is missing ${missing.join(', ')} there, so logs won't post until that's fixed.`;
        return text;
    });
}

async function event(i) {
    const g = findGuild(i.client, i.options.getString('server'));
    if (!g) return reply(i, { content: 'The bot isn\'t in that server.' });
    if (!(await getSettings(g.id))) return reply(i, { content: `**${g.name}** isn't set up yet. Use \`/owner setchannel\` first.` });
    const name = i.options.getString('event');
    const on = i.options.getBoolean('on');
    const events = name === 'all' ? EVENTS : EVENTS.includes(name) ? [name] : null;
    if (!events) return reply(i, { content: `Unknown event \`${cut(name, 50)}\`. Pick one from the list.` });
    const what = name === 'all' ? 'all events' : `\`${name}\``;
    return changeSettings(i, g, `Turn ${what} **${on ? 'on' : 'off'}** for **${g.name}**?`, async () => {
        await setEvents(g.id, events, on);
        return `${name === 'all' ? 'All events' : `\`${name}\``} turned **${on ? 'on' : 'off'}** for **${g.name}**.`;
    });
}

async function restore(i) {
    const g = findGuild(i.client, i.options.getString('server'));
    if (!g) return reply(i, { content: 'The bot isn\'t in that server.' });
    const snap = await getSnapshot(g.id);
    if (!snap) return reply(i, { content: `**${g.name}** isn't under maintenance, so there's nothing to restore.` });
    const c = await confirm(i, {
        content: `Restore **${g.name}**'s settings from ${ts(snap.takenAt)} and end maintenance?` +
            (snap.settings ? '' : '\n(It wasn\'t set up back then, so this removes its settings.)'),
        action: 'Restore',
    });
    if (!c) return;
    await restoreSnapshot(g.id);
    const note = c.notify ? `\n${await notifyServerOwner(g, notices.restored(g))}` : '';
    return c.done(`✅ Settings for **${g.name}** restored; maintenance is over.${note}`);
}

async function leave(i) {
    const g = findGuild(i.client, i.options.getString('server'));
    if (!g) return reply(i, { content: 'The bot isn\'t in that server.' });
    const reason = i.options.getString('reason');
    const c = await confirm(i, {
        content: `Leave **${g.name}** (${g.memberCount.toLocaleString()} members)? Its settings will be deleted. They can add the bot again later.` +
            (reason ? `\nReason: ${reason}` : ''),
        action: 'Leave', danger: true,
    });
    if (!c) return;
    const name = g.name;
    const note = c.notify ? `\n${await notifyServerOwner(g, notices.left(g, reason))}` : ''; // must notify before leaving
    await g.leave();
    return c.done(`Left **${name}** and deleted its settings.${note}`);
}

// ----- blacklist -----
async function blacklistAddCmd(i) {
    const id = (i.options.getString('id') || '').trim();
    const kind = i.options.getString('type') || 'server';
    const reason = i.options.getString('reason');
    if (!isId(id)) return reply(i, { content: 'That doesn\'t look like a Discord ID. Pick a server from the list or paste a user ID.' });
    if ((await ownerIds(i.client)).has(id) || id === i.client.user?.id) return reply(i, { content: 'You can\'t blacklist yourself or the bot.' });
    const affected = [...i.client.guilds.cache.values()].filter(g => (kind === 'server' ? g.id === id : g.ownerId === id));
    const label = kind === 'server'
        ? (affected[0] ? `server **${affected[0].name}** (\`${id}\`)` : `server \`${id}\``)
        : `user <@${id}> (\`${id}\`)`;
    const leaving = affected.length ? `\nThe bot will leave ${affected.length === 1 ? `**${affected[0].name}**` : `**${affected.length} servers** they own`} and delete their settings.` : '';
    const c = await confirm(i, {
        content: `Blacklist ${label} from using Logwarden?${leaving}${reason ? `\nReason: ${reason}` : ''}`,
        action: 'Blacklist', danger: true,
    });
    if (!c) return;
    await blacklistAdd(id, kind, reason);
    const notes = [];
    for (const g of affected) {
        if (c.notify) notes.push(`**${g.name}**: ${await notifyServerOwner(g, notices.blacklisted(g, reason, kind))}`);
        await g.leave();
    }
    let text = `⛔ Blacklisted ${label}.`;
    if (affected.length) text += ` Left ${affected.length} server${affected.length === 1 ? '' : 's'}.`;
    if (c.notify && !affected.length) text += '\n(The bot isn\'t in any of their servers, so there was no one to notify.)';
    if (notes.length) text += '\n' + notes.join('\n');
    return c.done(cut(text, 2000));
}

async function blacklistRemoveCmd(i) {
    const id = (i.options.getString('id') || '').trim();
    const removed = await blacklistRemove(id);
    return reply(i, { content: removed ? `Removed \`${id}\` from the blacklist. They can add the bot again.` : `\`${cut(id, 30)}\` isn't on the blacklist.` });
}

async function blacklistListCmd(i) {
    const rows = await blacklistAll();
    if (!rows.length) return reply(i, { content: 'The blacklist is empty.' });
    const lines = rows.slice(0, 25).map(r =>
        `${r.kind === 'user' ? '👤' : '🏠'} \`${r.id}\`${r.kind === 'user' ? ` <@${r.id}>` : ''} · ${ts(r.addedAt)}${r.reason ? `\n ${cut(r.reason, 120)}` : ''}`);
    const embed = new EmbedBuilder().setColor(WARN).setTitle(`Blacklist (${rows.length})`).setDescription(lines.join('\n'))
        .setFooter({ text: '🏠 server  👤 user (any server they own) · /owner blacklist remove to undo' });
    return reply(i, { embeds: [embed] });
}

async function errors(i) {
    if (i.options.getBoolean('clear')) {
        errorLog.clear();
        return reply(i, { content: 'Error list cleared.' });
    }
    const list = errorLog.recent(8);
    if (!list.length) return reply(i, { content: 'No errors recorded. 🎉' });
    const embed = new EmbedBuilder().setColor(WARN)
        .setTitle(`Recent errors (latest ${list.length} of ${errorLog.total()})`)
        .setDescription(list.map(e => {
            const where = e.guildId ? ` · server \`${e.guildId}\`` : '';
            return `${ts(e.at)} · ${e.source}${where}\n\`\`\`\n${cut(e.text.replace(/```/g, "'''"), 380)}\n\`\`\``;
        }).join('\n').slice(0, 4000))
        .setFooter({ text: 'Saved across restarts · /owner errors clear:true to reset' });
    return reply(i, { embeds: [embed] });
}

const handlers = {
    stats, servers, server, leave, setchannel, event, restore, errors,
    'blacklist:add': blacklistAddCmd, 'blacklist:remove': blacklistRemoveCmd, 'blacklist:list': blacklistListCmd,
};

// ---------- hooks used by index.js ----------
// Called when the bot joins a server, and for every server at startup.
async function enforceBlacklist(guild) {
    const hit = await blacklistGet([guild.id, guild.ownerId]);
    if (!hit) return false;
    await notifyServerOwner(guild, notices.blacklisted(guild, hit.reason, hit.kind));
    await guild.leave();
    console.log(`Left blacklisted server ${guild.id} (${hit.kind} ${hit.id}).`);
    return true;
}
async function onGuildDelete(guildId) {
    await ensureTables();
    await run(`DELETE FROM _snapshots WHERE guildId = ?`, [guildId]);
}

// ---------- command definition ----------
const serverOpt = (o) => o.setName('server').setDescription('Server (type to search)').setRequired(true).setAutocomplete(true);

module.exports = {
    ownerOnly: true,
    enforceBlacklist,
    onGuildDelete,
    data: new SlashCommandBuilder()
        .setName('owner')
        .setDescription('Bot owner dashboard')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false)
        .addSubcommand(s => s.setName('stats').setDescription('Bot stats: servers, members, uptime, memory'))
        .addSubcommand(s => s.setName('servers').setDescription('Every server the bot is in')
            .addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1)))
        .addSubcommand(s => s.setName('server').setDescription('Details and settings for one server').addStringOption(serverOpt))
        .addSubcommand(s => s.setName('setchannel').setDescription('Set a server\'s log channel (starts maintenance)')
            .addStringOption(serverOpt)
            .addStringOption(o => o.setName('channel').setDescription('Channel (pick a server first)').setRequired(true).setAutocomplete(true)))
        .addSubcommand(s => s.setName('event').setDescription('Turn an event on or off for a server (starts maintenance)')
            .addStringOption(serverOpt)
            .addStringOption(o => o.setName('event').setDescription('Event, or "all"').setRequired(true).setAutocomplete(true))
            .addBooleanOption(o => o.setName('on').setDescription('On or off').setRequired(true)))
        .addSubcommand(s => s.setName('restore').setDescription('End maintenance: put a server\'s saved settings back').addStringOption(serverOpt))
        .addSubcommand(s => s.setName('leave').setDescription('Make the bot leave a server')
            .addStringOption(serverOpt)
            .addStringOption(o => o.setName('reason').setDescription('Reason, shown to the server owner if notified').setMaxLength(300)))
        .addSubcommandGroup(grp => grp.setName('blacklist').setDescription('Block servers or users from using the bot')
            .addSubcommand(s => s.setName('add').setDescription('Blacklist a server or a user (and leave their servers)')
                .addStringOption(o => o.setName('id').setDescription('Server (type to search) or a user ID').setRequired(true).setAutocomplete(true))
                .addStringOption(o => o.setName('type').setDescription('Server or user (default: server)')
                    .addChoices({ name: 'Server', value: 'server' }, { name: 'User (any server they own)', value: 'user' }))
                .addStringOption(o => o.setName('reason').setDescription('Reason, shown to the server owner if notified').setMaxLength(300)))
            .addSubcommand(s => s.setName('remove').setDescription('Take a server or user off the blacklist')
                .addStringOption(o => o.setName('id').setDescription('Server or user ID').setRequired(true).setAutocomplete(true)))
            .addSubcommand(s => s.setName('list').setDescription('Everyone on the blacklist')))
        .addSubcommand(s => s.setName('errors').setDescription('The bot\'s recent errors')
            .addBooleanOption(o => o.setName('clear').setDescription('Clear the list'))),

    execute: async function (interaction) {
        if (!(await ownerIds(interaction.client)).has(interaction.user.id)) {
            return reply(interaction, { content: 'This command is only for the bot\'s owner.' });
        }
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();
        return handlers[group ? `${group}:${sub}` : sub](interaction);
    },

    autocomplete: async function (interaction) {
        if (!(await ownerIds(interaction.client)).has(interaction.user.id)) return interaction.respond([]);
        const focused = interaction.options.getFocused(true);
        const q = String(focused.value || '').toLowerCase();
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand(false);
        const serverChoices = (filter = () => true) => [...interaction.client.guilds.cache.values()]
            .filter(filter)
            .filter(g => g.name.toLowerCase().includes(q) || g.id.includes(q))
            .sort((a, b) => b.memberCount - a.memberCount)
            .map(g => ({ name: cut(`${g.name} · ${g.memberCount} members`, 100), value: g.id }));
        let choices = [];
        if (focused.name === 'server') {
            if (sub === 'restore') {
                const maint = await maintenanceIds();
                choices = serverChoices(g => maint.has(g.id));
            } else choices = serverChoices();
        } else if (focused.name === 'id' && group === 'blacklist' && sub === 'remove') {
            choices = (await blacklistAll())
                .filter(r => r.id.includes(q) || (r.reason || '').toLowerCase().includes(q))
                .map(r => ({ name: cut(`${r.kind === 'user' ? 'User' : 'Server'} ${r.id}${r.reason ? ` · ${r.reason}` : ''}`, 100), value: r.id }));
        } else if (focused.name === 'id') {
            choices = serverChoices();
            if (isId(q)) choices.unshift({ name: `Use ID ${q}`, value: q });
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
