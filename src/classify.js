import path from 'node:path';

const RASTER = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const SVG = new Set(['.svg']);
const ICO = new Set(['.ico']);
const FONT = new Set(['.ttf']);

/**
 * Telegram documents often arrive with `file_name` but no extension, or a generic name.
 * MIME from the Bot API is used to reconstruct an extension so `classifyByName` can run.
 */
const MIME_TO_EXT = {
	'image/jpeg': '.jpg',
	'image/jpg': '.jpg',
	'image/png': '.png',
	'image/gif': '.gif',
	'image/webp': '.webp',
	'image/svg+xml': '.svg',
	'image/x-icon': '.ico',
	'image/vnd.microsoft.icon': '.ico',
	'font/ttf': '.ttf',
	'application/x-font-ttf': '.ttf',
	'application/font-sfnt': '.ttf',
};

/**
 * Map a filename to a processing kind, or `null` if the bot should reject the file.
 * Raster / SVG / ICO are split because minify and WebP conversion treat them differently.
 */
export function classifyByName(filename) {
	const ext = path.extname(filename).toLowerCase();
	if (RASTER.has(ext)) {
		return 'raster';
	}
	if (SVG.has(ext)) {
		return 'svg';
	}
	if (ICO.has(ext)) {
		return 'ico';
	}
	if (FONT.has(ext)) {
		return 'font';
	}
	return null;
}

export function extensionFromMime(mime) {
	if (!mime) {
		return '';
	}
	return MIME_TO_EXT[mime.toLowerCase()] || '';
}

/** True for anything stored under `images/src` and handled by the image pipeline. */
export function isImageKind(kind) {
	return kind === 'raster' || kind === 'svg' || kind === 'ico';
}
