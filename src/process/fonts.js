import fs from 'node:fs/promises';
import path from 'node:path';
import ttf2woff2 from 'ttf2woff2';
import { listSourceFonts, userDirs } from '../storage.js';

/** Convert a TTF buffer to WOFF2. The library returns Uint8Array; Node writeFile wants Buffer. */
export function convertTtfToWoff2(buffer) {
	return Buffer.from(ttf2woff2(buffer));
}

/**
 * Convert every TTF in the user's `fonts/` folder.
 * Failures are skipped so one corrupt file does not abort the rest of the batch.
 * Successful paths are written to `fonts/dist/` and returned for Telegram delivery.
 */
export async function convertFonts(userId) {
	const dirs = userDirs(userId);
	const sources = await listSourceFonts(userId);
	const outputs = [];
	const errors = [];

	for (const source of sources) {
		try {
			const input = await fs.readFile(source);
			const woff2 = convertTtfToWoff2(input);
			const destName = `${path.parse(source).name}.woff2`;
			const dest = path.join(dirs.fontsDist, destName);
			await fs.writeFile(dest, woff2);
			outputs.push(dest);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`Skip ${source}: ${message}`);
			errors.push({ filePath: source, message });
		}
	}

	return { outputs, errors };
}
