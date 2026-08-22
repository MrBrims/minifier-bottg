import path from 'node:path';
import { Bot, InlineKeyboard } from 'grammy';
import { classifyByName, extensionFromMime, isImageKind } from './classify.js';
import { convertFonts } from './process/fonts.js';
import { minifyImages } from './process/images.js';
import { sendResultFiles } from './send.js';
import {
	clearAllUserFiles,
	clearFontJobFiles,
	clearImageJobFiles,
	ensureUserDirs,
	getInventory,
	getUserFolderSize,
	saveBuffer,
	USER_STORAGE_LIMIT_BYTES,
} from './storage.js';

const MAX_FILES_PER_BATCH = 30;
const BATCH_LIMIT_TEXT = 'Можно загрузить не более 30 файлов за раз.';

const START_TEXT =
	'Загрузите изображения или шрифт — после загрузки появятся кнопки действий.\n\n' +
	'За одну загрузку можно отправить не больше 30 файлов.\n\n' +
	'После загрузки доступны кнопки:\n' +
	'• Минифицировать — любая графика: растровая (JPG, PNG, GIF, WebP, ICO) и векторная (SVG)\n' +
	'• Минифицировать и преобразовать в WebP — растр минифицируется и преобразуется в WebP, вектор (SVG) только минифицируется. Растр и вектор можно загрузить вместе.\n' +
	'• Преобразовать в WOFF2 — шрифты TTF\n\n' +
	'Для исходного качества лучше отправлять изображения файлом, а не фото — Telegram сжимает фото.';

const albumTimers = new Map();
const lastMenu = new Map();
const busyUsers = new Set();
/** File kinds accumulated during the current upload debounce window. */
const pendingUploadBatch = new Map();
/** In-flight downloads per user — menu must wait until this is 0. */
const uploadInflight = new Map();

export function isUserBusy(userId) {
	return busyUsers.has(Number(userId));
}

function beginUpload(userId) {
	uploadInflight.set(userId, (uploadInflight.get(userId) || 0) + 1);
}

function endUpload(userId) {
	const next = (uploadInflight.get(userId) || 1) - 1;
	if (next <= 0) {
		uploadInflight.delete(userId);
	} else {
		uploadInflight.set(userId, next);
	}
}

async function ensureUploadingMessage(bot, chatId, userId) {
	// Once per pending batch — handlers often finish one file before the next starts,
	// so inflight briefly hits 0 and must not recreate the status message.
	const batch = pendingUploadBatch.get(userId);
	if (!batch || batch.uploadingMessageSent) {
		return;
	}
	batch.uploadingMessageSent = true;

	const previousId = lastMenu.get(userId);
	if (previousId) {
		try {
			await bot.api.deleteMessage(chatId, previousId);
		} catch {
			// Previous menu may already be gone.
		}
		lastMenu.delete(userId);
	}

	try {
		const message = await bot.api.sendMessage(chatId, 'Загружаю файлы…');
		lastMenu.set(userId, message.message_id);
	} catch (error) {
		console.error('Failed to send uploading message:', error);
	}
}

function emptyInventory() {
	return {
		raster: 0,
		svg: 0,
		ico: 0,
		font: 0,
		images: 0,
		hasImages: false,
		hasRaster: false,
		hasFonts: false,
		limitWarned: false,
		uploadingMessageSent: false,
	};
}

function batchFileCount(batch) {
	if (!batch) {
		return 0;
	}
	return (batch.raster || 0) + (batch.svg || 0) + (batch.ico || 0) + (batch.font || 0);
}

async function rejectIfBatchFull(ctx, bot, userId) {
	const batch = pendingUploadBatch.get(userId);
	const count = batchFileCount(batch);
	if (count < MAX_FILES_PER_BATCH) {
		return false;
	}
	if (batch && !batch.limitWarned) {
		batch.limitWarned = true;
		await ctx.reply(BATCH_LIMIT_TEXT);
	}
	scheduleActionMenu(bot, ctx.chat.id, userId);
	return true;
}

function inventoryFromCounts(counts) {
	const inventory = {
		raster: counts.raster || 0,
		svg: counts.svg || 0,
		ico: counts.ico || 0,
		font: counts.font || 0,
		images: 0,
	};
	inventory.images = inventory.raster + inventory.svg + inventory.ico;
	inventory.hasImages = inventory.images > 0;
	inventory.hasRaster = inventory.raster > 0;
	inventory.hasFonts = inventory.font > 0;
	return inventory;
}

function noteUploadKind(userId, kind) {
	let batch = pendingUploadBatch.get(userId);
	if (!batch) {
		batch = emptyInventory();
		pendingUploadBatch.set(userId, batch);
	}
	if (kind === 'raster') {
		batch.raster += 1;
	} else if (kind === 'svg') {
		batch.svg += 1;
	} else if (kind === 'ico') {
		batch.ico += 1;
	} else if (kind === 'font') {
		batch.font += 1;
	}
	batch.images = batch.raster + batch.svg + batch.ico;
	batch.hasImages = batch.images > 0;
	batch.hasRaster = batch.raster > 0;
	batch.hasFonts = batch.font > 0;
}

function unnoteUploadKind(userId, kind) {
	const batch = pendingUploadBatch.get(userId);
	if (!batch) {
		return;
	}
	if (kind === 'raster' && batch.raster > 0) {
		batch.raster -= 1;
	} else if (kind === 'svg' && batch.svg > 0) {
		batch.svg -= 1;
	} else if (kind === 'ico' && batch.ico > 0) {
		batch.ico -= 1;
	} else if (kind === 'font' && batch.font > 0) {
		batch.font -= 1;
	}
	batch.images = batch.raster + batch.svg + batch.ico;
	batch.hasImages = batch.images > 0;
	batch.hasRaster = batch.raster > 0;
	batch.hasFonts = batch.font > 0;
}

function takeUploadBatch(userId) {
	const batch = pendingUploadBatch.get(userId);
	pendingUploadBatch.delete(userId);
	return batch ? inventoryFromCounts(batch) : emptyInventory();
}

function inventorySummary(inventory) {
	const parts = [];
	if (inventory.raster) {
		parts.push(`растр: ${inventory.raster}`);
	}
	if (inventory.svg) {
		parts.push(`SVG: ${inventory.svg}`);
	}
	if (inventory.ico) {
		parts.push(`ICO: ${inventory.ico}`);
	}
	if (inventory.font) {
		parts.push(`TTF: ${inventory.font}`);
	}
	if (!parts.length) {
		return 'Успешно. Загрузите изображения или шрифт — после загрузки появятся кнопки действий.';
	}
	return `Загружено (${parts.join(', ')}). Выберите действие:`;
}

function actionKeyboard(inventory) {
	const keyboard = new InlineKeyboard();
	let hasButton = false;

	if (inventory.hasFonts) {
		keyboard.text('Преобразовать в WOFF2', 'act:woff2');
		hasButton = true;
	}

	if (inventory.hasImages) {
		if (hasButton) {
			keyboard.row();
		}
		keyboard.text('Минифицировать', 'act:minify');
		hasButton = true;
		if (inventory.hasRaster) {
			keyboard.row().text('Минифицировать и преобразовать в WebP', 'act:webp');
		}
	}

	return hasButton ? keyboard : undefined;
}

async function showActionMenu(bot, chatId, userId, inventory) {
	const resolved = inventory ?? (await getInventory(userId));
	const text = inventorySummary(resolved);
	const replyMarkup = actionKeyboard(resolved);
	const previousId = lastMenu.get(userId);

	// Always send a new menu after the latest message in the chat.
	// Editing the previous menu keeps buttons above newly uploaded files.
	if (previousId) {
		try {
			await bot.api.deleteMessage(chatId, previousId);
		} catch {
			// Previous menu may already be gone.
		}
		lastMenu.delete(userId);
	}

	const message = await bot.api.sendMessage(chatId, text, {
		reply_markup: replyMarkup,
	});
	lastMenu.set(userId, message.message_id);
}

function scheduleActionMenu(bot, chatId, userId) {
	const existing = albumTimers.get(userId);
	if (existing) {
		clearTimeout(existing);
	}

	const timer = setTimeout(() => {
		const inflight = uploadInflight.get(userId) || 0;
		if (inflight > 0) {
			scheduleActionMenu(bot, chatId, userId);
			return;
		}
		albumTimers.delete(userId);
		const batch = takeUploadBatch(userId);
		warnIfOverQuota(bot, chatId, userId)
			.catch((error) => {
				console.error('Failed to check storage quota:', error);
			})
			.finally(() => {
				showActionMenu(bot, chatId, userId, batch).catch((error) => {
					console.error('Failed to show action menu:', error);
				});
			});
	}, 600);

	albumTimers.set(userId, timer);
}

async function warnIfOverQuota(bot, chatId, userId) {
	const size = await getUserFolderSize(userId);
	if (size <= USER_STORAGE_LIMIT_BYTES) {
		return;
	}

	const keyboard = new InlineKeyboard().text('Очистить файлы', 'act:clear_all');
	await bot.api.sendMessage(
		chatId,
		'Превышен лимит хранения: в вашей папке больше 200 МБ файлов. Нажмите «Очистить файлы», чтобы удалить всё содержимое.',
		{ reply_markup: keyboard },
	);
}

async function downloadTelegramFile(bot, fileId) {
	const file = await bot.api.getFile(fileId);
	if (!file.file_path) {
		throw new Error('Telegram did not return a file path');
	}
	const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download file: ${response.status}`);
	}
	return Buffer.from(await response.arrayBuffer());
}

function documentFilename(document) {
	const original = document.file_name || 'file';
	if (path.extname(original)) {
		return original;
	}
	const ext = extensionFromMime(document.mime_type);
	return ext ? `${original}${ext}` : original;
}

async function saveIncoming(userId, filename, buffer) {
	const dirs = await ensureUserDirs(userId);
	const kind = classifyByName(filename);
	if (kind === 'font') {
		return saveBuffer(dirs.fonts, filename, buffer);
	}
	if (isImageKind(kind)) {
		return saveBuffer(dirs.imagesSrc, filename, buffer);
	}
	return null;
}

function withBusy(userId, fn) {
	return async (ctx) => {
		if (busyUsers.has(userId)) {
			await ctx.reply('Дождитесь окончания текущей операции.');
			return;
		}
		busyUsers.add(userId);
		try {
			await fn(ctx);
		} finally {
			busyUsers.delete(userId);
		}
	};
}

export function createBot(token) {
	const bot = new Bot(token);

	bot.command('start', async (ctx) => {
		if (!ctx.from) {
			return;
		}
		await ensureUserDirs(ctx.from.id);
		lastMenu.delete(ctx.from.id);
		pendingUploadBatch.delete(ctx.from.id);
		uploadInflight.delete(ctx.from.id);
		await ctx.reply(START_TEXT, { reply_markup: { remove_keyboard: true } });
	});

	bot.on('message:photo', async (ctx) => {
		if (!ctx.from || !ctx.chat) {
			return;
		}
		const photo = ctx.message.photo.at(-1);
		if (!photo) {
			return;
		}
		const userId = ctx.from.id;
		if (await rejectIfBatchFull(ctx, bot, userId)) {
			return;
		}
		noteUploadKind(userId, 'raster');
		beginUpload(userId);
		await ensureUploadingMessage(bot, ctx.chat.id, userId);
		try {
			const buffer = await downloadTelegramFile(bot, photo.file_id);
			await saveIncoming(userId, `photo-${photo.file_unique_id}.jpg`, buffer);
			scheduleActionMenu(bot, ctx.chat.id, userId);
		} catch (error) {
			console.error(error);
			unnoteUploadKind(userId, 'raster');
			await ctx.reply('Не удалось сохранить фото.');
		} finally {
			endUpload(userId);
		}
	});

	bot.on('message:document', async (ctx) => {
		if (!ctx.from || !ctx.chat || !ctx.message.document) {
			return;
		}
		const document = ctx.message.document;
		const filename = documentFilename(document);
		const kind = classifyByName(filename);
		if (!kind) {
			await ctx.reply(
				'Поддерживаются изображения JPG, PNG, GIF, WebP, SVG, ICO и шрифты TTF.',
			);
			return;
		}
		const userId = ctx.from.id;
		if (await rejectIfBatchFull(ctx, bot, userId)) {
			return;
		}
		noteUploadKind(userId, kind);
		beginUpload(userId);
		await ensureUploadingMessage(bot, ctx.chat.id, userId);
		try {
			const buffer = await downloadTelegramFile(bot, document.file_id);
			await saveIncoming(userId, filename, buffer);
			scheduleActionMenu(bot, ctx.chat.id, userId);
		} catch (error) {
			console.error(error);
			unnoteUploadKind(userId, kind);
			await ctx.reply('Не удалось сохранить файл.');
		} finally {
			endUpload(userId);
		}
	});

	bot.callbackQuery('act:woff2', async (ctx) => {
		if (!ctx.from || !ctx.chat) {
			return;
		}
		await ctx.answerCallbackQuery();
		await withBusy(ctx.from.id, async () => {
			await ctx.reply('Преобразую шрифты в WOFF2…');
			const { outputs, errors } = await convertFonts(ctx.from.id);
			await sendResultFiles(bot, ctx.chat.id, outputs);
			if (outputs.length) {
				await clearFontJobFiles(ctx.from.id);
			}
			if (errors.length) {
				await ctx.reply(`Пропущено файлов: ${errors.length}.`);
			}
			await showActionMenu(bot, ctx.chat.id, ctx.from.id);
		})(ctx);
	});

	bot.callbackQuery('act:minify', async (ctx) => {
		if (!ctx.from || !ctx.chat) {
			return;
		}
		await ctx.answerCallbackQuery();
		await withBusy(ctx.from.id, async () => {
			await ctx.reply('Минифицирую изображения…');
			const { outputs, errors } = await minifyImages(ctx.from.id, { toWebp: false });
			await sendResultFiles(bot, ctx.chat.id, outputs);
			if (outputs.length) {
				await clearImageJobFiles(ctx.from.id);
			}
			if (errors.length) {
				await ctx.reply(`Пропущено файлов: ${errors.length}.`);
			}
			await showActionMenu(bot, ctx.chat.id, ctx.from.id);
		})(ctx);
	});

	bot.callbackQuery('act:webp', async (ctx) => {
		if (!ctx.from || !ctx.chat) {
			return;
		}
		await ctx.answerCallbackQuery();
		await withBusy(ctx.from.id, async () => {
			await ctx.reply('Минифицирую и преобразую в WebP…');
			const { outputs, errors } = await minifyImages(ctx.from.id, { toWebp: true });
			await sendResultFiles(bot, ctx.chat.id, outputs);
			if (outputs.length) {
				await clearImageJobFiles(ctx.from.id);
			}
			if (errors.length) {
				await ctx.reply(`Пропущено файлов: ${errors.length}.`);
			}
			await showActionMenu(bot, ctx.chat.id, ctx.from.id);
		})(ctx);
	});

	bot.callbackQuery('act:clear_all', async (ctx) => {
		if (!ctx.from || !ctx.chat) {
			return;
		}
		await ctx.answerCallbackQuery();
		await withBusy(ctx.from.id, async () => {
			await clearAllUserFiles(ctx.from.id);
			await ctx.reply('Все файлы в вашей папке удалены.');
			await showActionMenu(bot, ctx.chat.id, ctx.from.id);
		})(ctx);
	});

	bot.catch((error) => {
		console.error('Bot error:', error);
	});

	return bot;
}
