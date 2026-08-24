import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_ROOT } from './storage.js';

/**
 * Locale pin lives under `prefs/`, not in the user's upload tree, so "clear all"
 * and the TTL sweeper never delete the /lang choice.
 */
function prefsPath(userId) {
	return path.join(DATA_ROOT, 'prefs', `${userId}.json`);
}

/** Stored `ru`/`en`, or `null` when the file is missing, invalid, or auto. */
export async function getLocaleOverride(userId) {
	try {
		const raw = await fs.readFile(prefsPath(userId), 'utf8');
		const data = JSON.parse(raw);
		if (data.locale === 'ru' || data.locale === 'en') {
			return data.locale;
		}
		return null;
	} catch (error) {
		if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) {
			return null;
		}
		throw error;
	}
}

/** Write a pin, or delete the file when locale is not `ru`/`en` (follow Telegram). */
export async function setLocaleOverride(userId, locale) {
	const dest = prefsPath(userId);
	if (locale !== 'ru' && locale !== 'en') {
		await fs.rm(dest, { force: true });
		return;
	}
	await fs.mkdir(path.dirname(dest), { recursive: true });
	await fs.writeFile(dest, JSON.stringify({ locale }), 'utf8');
}
