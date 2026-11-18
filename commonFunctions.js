const sqlite3 = require("sqlite3");

module.exports = {
    eventState: function(guild, event) {
        let db = new sqlite3.Database('config.db', sqlite3.OPEN_READONLY ,(err) => {if (err) {console.log(err.message);}});
        return new Promise((resolve) => {
            db.all(`SELECT "${event}" FROM "${guild}"`, (err, val) => {
                db.close();
                if (err || !val || val.length === 0) return resolve(false);
                const v = val[0][event];
                if (v === 0) return resolve(false);
                if (v === 1) return resolve(true);
                resolve(v);
            })
        })
    },

    // True only if this server's table exists AND has its settings row.
    tableExists: async function (guild) {
        let db = new sqlite3.Database('config.db', sqlite3.OPEN_READONLY ,(err) => {if (err) {console.log(err.message);}});
        return new Promise((resolve) => {
            db.all(`SELECT COUNT(*) AS n FROM "${guild}"`, (err, val) => {
                db.close();
                resolve(!err && val && val[0].n > 0);
            })
        })
    }
}
