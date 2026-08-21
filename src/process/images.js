import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { decodeIco, encodeIco } from 'icojs';
import { optimize as svgoOptimize } from 'svgo';
import { classifyByName } from '../classify.js';
import { listSourceImages, userDirs } from '../storage.js';

const jpegOptions = {
	quality: 80,
	progressive: true,
	mozjpeg: true,
};

const pngOptions = {
	quality: 70,
	compressionLevel: 9,
	palette: true,
};

const webpOptions = {
	quality: 80,
};

const svgoConfig = {
	plugins: [
		{
			name: 'preset-default',
			params: {
				overrides: {
					removeUselessStrokeAndFill: false,
				},
			},
		},
		{
			name: 'removeViewBox',
			active: false,
		},
	],
};

export async function minifyRasterBuffer(buffer, ext) {
	const image = sharp(buffer, { animated: true, failOn: 'none' });

	if (ext === '.jpg' || ext === '.jpeg') {
		return image.jpeg(jpegOptions).toBuffer();
	}

	if (ext === '.png') {
		return image.png(pngOptions).toBuffer();
	}

	if (ext === '.gif') {
		return image.gif().toBuffer();
	}

	if (ext === '.webp') {
		return image.webp(webpOptions).toBuffer();
	}

	return buffer;
}

export async function convertWebpBuffer(buffer) {
	return sharp(buffer, {
		animated: true,
		failOn: 'none',
	})
		.webp(webpOptions)
		.toBuffer();
}

export async function minifySvgBuffer(buffer, filePath) {
	const result = svgoOptimize(buffer.toString('utf8'), {
		path: filePath,
		...svgoConfig,
	});
	return Buffer.from(result.data);
}

export async function minifyIcoBuffer(buffer) {
	try {
		const images = await decodeIco(buffer, 'image/png');
		const frames = [];

		for (const image of images) {
			const png = await sharp(Buffer.from(image.buffer), {
				failOn: 'none',
			})
				.png(pngOptions)
				.toBuffer();
			frames.push({ buffer: png });
		}

		const encoded = Buffer.from(await encodeIco(frames));
		if (encoded.length < buffer.length) {
			return encoded;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`ICO skip: ${message}`);
	}

	return buffer;
}

async function processOne(filePath, handler) {
	try {
		const input = await fs.readFile(filePath);
		await handler(input);
		return { ok: true, filePath };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Skip ${filePath}: ${message}`);
		return { ok: false, filePath, message };
	}
}

export async function minifyImages(userId, { toWebp = false } = {}) {
	const dirs = userDirs(userId);
	const sources = await listSourceImages(userId);
	const outputs = [];
	const errors = [];

	for (const source of sources) {
		const kind = classifyByName(source);
		const ext = path.extname(source).toLowerCase();
		const name = path.basename(source);

		if (kind === 'svg') {
			const result = await processOne(source, async (input) => {
				const minified = await minifySvgBuffer(input, source);
				const dest = path.join(dirs.imagesDist, name);
				await fs.writeFile(dest, minified);
				outputs.push(dest);
			});
			if (!result.ok) {
				errors.push(result);
			}
			continue;
		}

		if (kind === 'ico') {
			const result = await processOne(source, async (input) => {
				const minified = await minifyIcoBuffer(input);
				const minificPath = path.join(dirs.imagesMinific, name);
				const distPath = path.join(dirs.imagesDist, name);
				await fs.writeFile(minificPath, minified);
				await fs.writeFile(distPath, minified);
				outputs.push(toWebp ? distPath : minificPath);
			});
			if (!result.ok) {
				errors.push(result);
			}
			continue;
		}

		if (kind === 'raster') {
			const result = await processOne(source, async (input) => {
				const minified = await minifyRasterBuffer(input, ext);
				const minificPath = path.join(dirs.imagesMinific, name);
				await fs.writeFile(minificPath, minified);

				if (toWebp) {
					const webp = await convertWebpBuffer(minified);
					const distName = `${path.parse(name).name}.webp`;
					const distPath = path.join(dirs.imagesDist, distName);
					await fs.writeFile(distPath, webp);
					outputs.push(distPath);
				} else {
					outputs.push(minificPath);
				}
			});
			if (!result.ok) {
				errors.push(result);
			}
		}
	}

	return { outputs, errors };
}
