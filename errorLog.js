// Keeps the bot's most recent errors so the owner can see them with /owner errors.
// Errors are saved to errors.json, so they survive the bot crashing and pm2 restarting it.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'errors.json');
const MAX = 50;

let errors = [];
try { errors = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { errors = []; }
const startedAt = Date.now();

function save() {
    try { fs.writeFileSync(FILE, JSON.stringify(errors.slice(-MAX))); } catch { /* ignore */ }
}

function describe(args) {
    return args.map(a => {
        if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
        return String(a);
    }).join(' ');
}

function record(source, args) {
    const text = describe(args).slice(0, 1500);
    const guildId = args.find(a => a && a.guild && a.guild.id)?.guild.id;
    errors.push({ at: Date.now(), source, text, guildId: guildId || null });
    if (errors.length > MAX) errors = errors.slice(-MAX);
    save();
}

// console.error always counts; console.log counts when it's given an Error object
// (the original code logs most caught errors with console.log).
const origError = console.error.bind(console);
const origLog = console.log.bind(console);
console.error = (...args) => { record('console.error', args); origError(...args); };
console.log = (...args) => {
    if (args.some(a => a instanceof Error)) record('console.log', args);
    origLog(...args);
};

process.on('unhandledRejection', (reason) => {
    record('unhandledRejection', [reason]);
    origError('Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
    record('crash', [err]);
    origError('Uncaught exception, exiting so pm2 restarts the bot:', err);
    process.exit(1);
});

module.exports = {
    recent: (n = 10) => errors.slice(-n).reverse(),
    countSinceStart: () => errors.filter(e => e.at >= startedAt).length,
    total: () => errors.length,
    clear: () => { errors = []; save(); },
    record,
};
