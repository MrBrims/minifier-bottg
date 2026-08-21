import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InputFile } from 'grammy';
import archiver from 'archiver';

const ZIP_THRESHOLD = 2;

async function zipFiles(filePaths, zipPath) {
	await new Promise((resolve, reject) => {
		const output = createWriteStream(zipPath);
		const archive = archiver('zip', { zlib: { level: 9 } });

		output.on('close', resolve);
		output.on('error', reject);
		archive.on('error', reject);

		archive.pipe(output);
		for (const filePath of filePaths) {
			archive.file(filePath, { name: path.basename(filePath) });
		}
		archive.finalize();
	});
}

export async function sendResultFiles(bot, chatId, filePaths) {
	if (!filePaths.length) {
		await bot.api.sendMessage(chatId, 'Не удалось обработать файлы.');
		return;
	}

	if (filePaths.length > ZIP_THRESHOLD) {
		const zipPath = path.join(os.tmpdir(), `minifi-${chatId}-${Date.now()}.zip`);
		try {
			await zipFiles(filePaths, zipPath);
			await bot.api.sendDocument(chatId, new InputFile(zipPath, 'result.zip'));
		} finally {
			await fs.rm(zipPath, { force: true });
		}
		return;
	}

	for (const filePath of filePaths) {
		await bot.api.sendDocument(
			chatId,
			new InputFile(filePath, path.basename(filePath)),
		);
	}
}
