# Privacy Policy

Last updated: November 18, 2026

## 1. What the bot stores

For each server that sets it up, Logwarden saves:

- the server's ID
- the ID of the channel chosen with `/setchannel`
- which events are turned on or off with `/config`

Two other things may be saved by the bot's owner:

- **Maintenance copies:** before the owner changes a server's Logwarden settings during maintenance, a copy of that server's settings (the same three items above) is kept so they can be restored. It is deleted once restored, or when the bot leaves the server.
- **Blacklist:** if a server or user is blocked from using the bot, their server or user ID, the date, and the reason given are kept so the block keeps working.

That is all the bot saves to disk. It does not keep a database of messages, members or activity.

## 2. What the bot processes

To post logs, the bot receives events from Discord, such as messages, edits, deletions, member joins and leaves, role and channel changes, voice activity and audit log entries. Discord.js keeps recent messages in memory for a short time so that the bot can show what a message said before it was edited or deleted. This memory is cleared when the bot restarts and is never written to disk.

The logs themselves are posted in the log channel of your own server. Once posted, they are stored by Discord as normal messages and are controlled by that server's staff, not by us.

## 3. Sharing

We do not sell or share any data. Data is only sent to Discord, as needed to post logs.

## 4. Deleting data

When the bot is removed from a server, that server's saved settings and any maintenance copy are deleted automatically. Blacklist entries are kept until the owner removes them; to ask about one, contact us below. Logs already posted in your server can be deleted by your server's staff like any other message.

## 5. Third parties

The bot runs on Discord, and your use of Discord is covered by [Discord's Privacy Policy](https://discord.com/privacy).

## 6. Changes

We may update this policy. The date at the top shows the latest version.

## 7. Contact

Questions or deletion requests? Open an issue on [GitHub](https://github.com/tomg12345667/sturdy-waffle/issues).
