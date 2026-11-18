// pm2 config for OpenLoggerBot
// Place this file in the root of the OpenLoggerBot folder, then: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "openloggerbot",
      script: "index.js",
      // The bot uses relative paths (./config.json, ./commands, ./events, config.db),
      // so it MUST run with its own folder as the working directory.
      cwd: __dirname,
      instances: 1,          // Discord bots must run as a single instance
      exec_mode: "fork",
      autorestart: true,
      watch: false,          // config.db changes constantly; watching would cause restart loops
      max_memory_restart: "500M",
      restart_delay: 5000,   // wait 5s between restarts to avoid hammering Discord's login
      env: {
        NODE_ENV: "production",
      },
      time: true,            // timestamp pm2 log lines
    },
  ],
};
