import 'dotenv/config';
import { createBot, isUserBusy } from './bot.js';
import { purgeExpiredFiles, TTL_SWEEP_INTERVAL_MS } from './storage.js';

const token = process.env.BOT_TOKEN;

if (!token) {
	console.error('BOT_TOKEN is required');
	process.exit(1);
}

const bot = createBot(token);

await bot.api.setMyCommands([{ command: 'start', description: 'Начать' }]);

function runTtlSweep() {
	purgeExpiredFiles({ skipUser: isUserBusy }).catch((error) => {
		console.error('TTL sweep failed:', error);
	});
}

runTtlSweep();
setInterval(runTtlSweep, TTL_SWEEP_INTERVAL_MS);

bot.start({
	onStart: (info) => {
		console.log(`Bot @${info.username} started`);
	},
});
