import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyByName } from './classify.js';

const DATA_ROOT = process.env.DATA_DIR || path.join(process.cwd(), 'data');

export const FILE_TTL_MS = 10 * 60 * 1000;
export const TTL_SWEEP_INTERVAL_MS = 30 * 1000;
export const USER_STORAGE_LIMIT_BYTES = 200 * 1024 * 1024;

export function userDirs(userId) {
	const root = path.join(DATA_ROOT, String(userId));

	return {
		root,
		imagesSrc: path.join(root, 'images', 'src'),
		imagesMinific: path.join(root, 'images', 'minific'),
		imagesDist: path.join(root, 'images', 'dist'),
		fonts: path.join(root, 'fonts'),
		fontsDist: path.join(root, 'fonts', 'dist'),
	};
}

export async function ensureUserDirs(userId) {
	const dirs = userDirs(userId);
	await Promise.all(
		[
			dirs.imagesSrc,
			dirs.imagesMinific,
			dirs.imagesDist,
			dirs.fonts,
			dirs.fontsDist,
		].map((dir) => fs.mkdir(dir, { recursive: true })),
	);
	return dirs;
}

export function safeBasename(name) {
	const base = path.basename(String(name || 'file')).replace(/[<>:"|?*\u0000-\u001f]/g, '_');
	return base || 'file';
}

async function pathExists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function uniqueFilePath(dir, filename) {
	const safe = safeBasename(filename);
	let dest = path.join(dir, safe);
	if (!(await pathExists(dest))) {
		return dest;
	}

	const parsed = path.parse(safe);
	let index = 1;
	while (await pathExists(path.join(dir, `${parsed.name}-${index}${parsed.ext}`))) {
		index += 1;
	}
	return path.join(dir, `${parsed.name}-${index}${parsed.ext}`);
}

export async function saveBuffer(dir, filename, buffer) {
	await fs.mkdir(dir, { recursive: true });
	const dest = await uniqueFilePath(dir, filename);
	await fs.writeFile(dest, buffer);
	return dest;
}

async function listFiles(dir) {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile())
			.map((entry) => path.join(dir, entry.name));
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

export async function listSourceImages(userId) {
	const dirs = userDirs(userId);
	return listFiles(dirs.imagesSrc);
}

export async function listSourceFonts(userId) {
	const dirs = userDirs(userId);
	const files = await listFiles(dirs.fonts);
	return files.filter((file) => classifyByName(file) === 'font');
}

export async function getInventory(userId) {
	await ensureUserDirs(userId);
	const images = await listSourceImages(userId);
	const fonts = await listSourceFonts(userId);

	const inventory = {
		raster: 0,
		svg: 0,
		ico: 0,
		font: fonts.length,
		images: images.length,
	};

	for (const file of images) {
		const kind = classifyByName(file);
		if (kind === 'raster') {
			inventory.raster += 1;
		} else if (kind === 'svg') {
			inventory.svg += 1;
		} else if (kind === 'ico') {
			inventory.ico += 1;
		}
	}

	inventory.hasImages = inventory.raster + inventory.svg + inventory.ico > 0;
	inventory.hasRaster = inventory.raster > 0;
	inventory.hasFonts = inventory.font > 0;

	return inventory;
}

async function emptyDir(dir) {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		await Promise.all(
			entries.map((entry) =>
				fs.rm(path.join(dir, entry.name), { recursive: true, force: true }),
			),
		);
	} catch (error) {
		if (error && error.code !== 'ENOENT') {
			throw error;
		}
	}
}

export async function clearImageJobFiles(userId) {
	const dirs = await ensureUserDirs(userId);
	await emptyDir(dirs.imagesSrc);
	await emptyDir(dirs.imagesMinific);
	await emptyDir(dirs.imagesDist);
}

export async function clearFontJobFiles(userId) {
	const dirs = await ensureUserDirs(userId);
	const fonts = await listSourceFonts(userId);
	await Promise.all(fonts.map((file) => fs.rm(file, { force: true })));
	await emptyDir(dirs.fontsDist);
}

export async function clearAllUserFiles(userId) {
	const dirs = userDirs(userId);
	await emptyDir(dirs.root);
	await ensureUserDirs(userId);
}

async function dirSize(dir) {
	let total = 0;
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			return 0;
		}
		throw error;
	}

	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			total += await dirSize(full);
		} else if (entry.isFile()) {
			const stats = await fs.stat(full);
			total += stats.size;
		}
	}

	return total;
}

export async function getUserFolderSize(userId) {
	return dirSize(userDirs(userId).root);
}

export async function purgeExpiredFiles({ skipUser } = {}) {
	let userIds;
	try {
		const entries = await fs.readdir(DATA_ROOT, { withFileTypes: true });
		userIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			return;
		}
		throw error;
	}

	const cutoff = Date.now() - FILE_TTL_MS;

	for (const userId of userIds) {
		if (skipUser?.(userId)) {
			continue;
		}

		const dirs = userDirs(userId);
		const fileDirs = [
			dirs.imagesSrc,
			dirs.imagesMinific,
			dirs.imagesDist,
			dirs.fonts,
			dirs.fontsDist,
		];

		for (const dir of fileDirs) {
			const files = await listFiles(dir);
			for (const file of files) {
				const stats = await fs.stat(file);
				if (stats.mtimeMs < cutoff) {
					await fs.rm(file, { force: true });
				}
			}
		}
	}
}
