import path from 'node:path';
import { Bot, InlineKeyboard } from 'grammy';
import { classifyByName, extensionFromMime, isImageKind } from './classify.js';
import { applyLocaleOverride, getLocale, rememberLocale, t } from './i18n.js';
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

/**
 * Soft cap for one debounce window. Telegram albums arrive as many separate updates,
 * so this is counted in memory (`pendingUploadBatch`), not by scanning the disk.
 */
const MAX_FILES_PER_BATCH = 100;

/** Translate using the locale resolved for this user ( /lang pin or Telegram language). */
function userT(userId, key, params) {
	return t(getLocale(userId), key, params);
}

/**
 * Per-user timer that fires after a burst of album/document updates stops.
 * Each new file resets the delay so the action menu appears once, not per file.
 */
const albumTimers = new Map();

/** Last status/menu message id so it can be deleted before a newer one is sent. */
const lastMenu = new Map();

/** Users currently running minify / convert / clear — blocks overlapping jobs and TTL. */
const busyUsers = new Set();

/**
 * File-kind counts accumulated during the current upload debounce window.
 * Used to build the keyboard without waiting for a full disk inventory scan.
 */
const pendingUploadBatch = new Map();

/**
 * In-flight Telegram downloads per user. The menu must not appear while this is > 0,
 * otherwise buttons show up before the last file is written to disk.
 */
const uploadInflight = new Map();

/**
 * TTL sweep passes directory names (strings); `busyUsers` stores numeric Telegram ids.
 * Coerce so a busy user is actually skipped during purge.
 */
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

/**
 * Send "Загружаю файлы…" once per pending batch.
 * Handlers often finish one file before the next starts, so inflight briefly hits 0;
 * `uploadingMessageSent` prevents a new status message on every file.
 */
async function ensureUploadingMessage(bot, chatId, userId) {
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
			// Previous menu may already be gone (user deleted it, or chat was cleared).
		}
		lastMenu.delete(userId);
	}

	try {
		const message = await bot.api.sendMessage(chatId, userT(userId, 'uploading'));
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

/**
 * Reject files beyond `MAX_FILES_PER_BATCH` in the current debounce window.
 * The warning is sent once per window so a 100+ album does not spam the chat.
 * The menu is still scheduled so files already accepted remain actionable.
 */
async function rejectIfBatchFull(ctx, bot, userId) {
	const batch = pendingUploadBatch.get(userId);
	const count = batchFileCount(batch);
	if (count < MAX_FILES_PER_BATCH) {
		return false;
	}
	if (batch && !batch.limitWarned) {
		batch.limitWarned = true;
		await ctx.reply(userT(userId, 'batchLimit'));
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

/** Record a successful classification into the in-memory batch (before download finishes). */
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

/** Roll back `noteUploadKind` if download or save fails, so the menu matches the disk. */
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

/** Consume the debounce window's counts and clear the map so the next album starts fresh. */
function takeUploadBatch(userId) {
	const batch = pendingUploadBatch.get(userId);
	pendingUploadBatch.delete(userId);
	return batch ? inventoryFromCounts(batch) : emptyInventory();
}

/** Status line under the action buttons, translated for this user. */
function inventorySummary(userId, inventory) {
	const parts = [];
	if (inventory.raster) {
		parts.push(userT(userId, 'kindRaster', { count: inventory.raster }));
	}
	if (inventory.svg) {
		parts.push(userT(userId, 'kindSvg', { count: inventory.svg }));
	}
	if (inventory.ico) {
		parts.push(userT(userId, 'kindIco', { count: inventory.ico }));
	}
	if (inventory.font) {
		parts.push(userT(userId, 'kindTtf', { count: inventory.font }));
	}
	if (!parts.length) {
		return userT(userId, 'inventoryEmpty');
	}
	return userT(userId, 'inventoryLoaded', { parts: parts.join(', ') });
}

/** Inline actions; labels follow the user's locale. Hidden when the folder is empty. */
function actionKeyboard(userId, inventory) {
	const keyboard = new InlineKeyboard();
	let hasButton = false;

	if (inventory.hasFonts) {
		keyboard.text(userT(userId, 'btnWoff2'), 'act:woff2');
		hasButton = true;
	}

	if (inventory.hasImages) {
		if (hasButton) {
			keyboard.row();
		}
		keyboard.text(userT(userId, 'btnMinify'), 'act:minify');
		hasButton = true;
		// SVG and ICO stay in their formats; the extra WebP button only makes sense with raster.
		if (inventory.hasRaster) {
			keyboard.row().text(userT(userId, 'btnWebp'), 'act:webp');
		}
	}

	if (hasButton) {
		keyboard.row().text(userT(userId, 'btnClear'), 'act:clear_all');
	}

	return hasButton ? keyboard : undefined;
}

/**
 * Replace the previous status/menu with a new one at the bottom of the chat.
 * Editing the old message would leave action buttons above newly uploaded files.
 */
async function showActionMenu(bot, chatId, userId, inventory) {
	const resolved = inventory ?? (await getInventory(userId));
	const text = inventorySummary(userId, resolved);
	const replyMarkup = actionKeyboard(userId, resolved);
	const previousId = lastMenu.get(userId);

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

/**
 * Debounce the action menu: 600 ms after the last file update, or keep waiting
 * while downloads are still in flight. Then check quota and show buttons.
 */
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

	const keyboard = new InlineKeyboard().text(userT(userId, 'btnClearFiles'), 'act:clear_all');
	await bot.api.sendMessage(chatId, userT(userId, 'quotaExceeded'), {
		reply_markup: keyboard,
	});
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
	// Telegram sometimes omits the extension; MIME from the Bot API is the fallback.
	const ext = extensionFromMime(document.mime_type);
	return ext ? `${original}${ext}` : original;
}

/** Persist an uploaded buffer into the matching per-user folder, or `null` if unsupported. */
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

/**
 * Serialize jobs per user so two overlapping callbacks cannot race on the same folders,
 * and so the TTL sweeper can skip this user via `isUserBusy`.
 */
function withBusy(userId, fn) {
	return async (ctx) => {
		if (busyUsers.has(userId)) {
			await ctx.reply(userT(userId, 'busy'));
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

	// Cache language_code (and load a /lang pin) so later replies that only have userId
	// still pick the right catalog — album debounce and quota warnings have no ctx.
	bot.use(async (ctx, next) => {
		if (ctx.from) {
			await rememberLocale(ctx.from.id, ctx.from.language_code);
		}
		await next();
	});

	bot.command('start', async (ctx) => {
		if (!ctx.from) {
			return;
		}
		await ensureUserDirs(ctx.from.id);
		lastMenu.delete(ctx.from.id);
		pendingUploadBatch.delete(ctx.from.id);
		uploadInflight.delete(ctx.from.id);
		// Drop a leftover reply keyboard from older bot versions that used one.
		await ctx.reply(userT(ctx.from.id, 'start'), {
			parse_mode: 'HTML',
			reply_markup: { remove_keyboard: true },
		});
	});

	bot.command('lang', async (ctx) => {
		// Pin Russian, English, or follow the Telegram app language.
		if (!ctx.from) {
			return;
		}
		const locale = getLocale(ctx.from.id);
		const keyboard = new InlineKeyboard()
			.text(t(locale, 'btnLangRu'), 'lang:ru')
			.text(t(locale, 'btnLangEn'), 'lang:en')
			.row()
			.text(t(locale, 'btnLangAuto'), 'lang:auto');
		await ctx.reply(t(locale, 'langPrompt'), { reply_markup: keyboard });
	});

	bot.callbackQuery(/^lang:(ru|en|auto)$/, async (ctx) => {
		if (!ctx.from) {
			return;
		}
		const choice = ctx.match[1];
		// Confirm in the locale that is now active (auto uses Telegram language_code).
		await applyLocaleOverride(ctx.from.id, choice === 'auto' ? null : choice);
		const locale = getLocale(ctx.from.id);
		const confirmKey =
			choice === 'ru' ? 'langSetRu' : choice === 'en' ? 'langSetEn' : 'langSetAuto';
		await ctx.answerCallbackQuery();
		await ctx.reply(t(locale, confirmKey));
	});

	bot.on('message:photo', async (ctx) => {
		if (!ctx.from || !ctx.chat) {
			return;
		}
		// Telegram sends every thumbnail size; the last entry is the largest.
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
			await ctx.reply(userT(userId, 'savePhotoFailed'));
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
			await ctx.reply(userT(ctx.from.id, 'unsupportedType'));
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
			await ctx.reply(userT(userId, 'saveFileFailed'));
		} finally {
			endUpload(userId);
		}
	});

	bot.callbackQuery('act:woff2', async (ctx) => {
		if (!ctx.from || !ctx.chat) {
			return;
		}
		// Answer first — Telegram times out the loading spinner on the button otherwise.
		await ctx.answerCallbackQuery();
		await withBusy(ctx.from.id, async () => {
			await ctx.reply(userT(ctx.from.id, 'convertingFonts'));
			const { outputs, errors } = await convertFonts(ctx.from.id);
			await sendResultFiles(bot, ctx.chat.id, outputs, getLocale(ctx.from.id));
			// Keep sources when every file failed so the user can retry without re-uploading.
			if (outputs.length) {
				await clearFontJobFiles(ctx.from.id);
			}
			if (errors.length) {
				await ctx.reply(userT(ctx.from.id, 'skippedFiles', { count: errors.length }));
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
			await ctx.reply(userT(ctx.from.id, 'minifyingImages'));
			const { outputs, errors } = await minifyImages(ctx.from.id, { toWebp: false });
			await sendResultFiles(bot, ctx.chat.id, outputs, getLocale(ctx.from.id));
			if (outputs.length) {
				await clearImageJobFiles(ctx.from.id);
			}
			if (errors.length) {
				await ctx.reply(userT(ctx.from.id, 'skippedFiles', { count: errors.length }));
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
			await ctx.reply(userT(ctx.from.id, 'convertingWebp'));
			const { outputs, errors } = await minifyImages(ctx.from.id, { toWebp: true });
			await sendResultFiles(bot, ctx.chat.id, outputs, getLocale(ctx.from.id));
			if (outputs.length) {
				await clearImageJobFiles(ctx.from.id);
			}
			if (errors.length) {
				await ctx.reply(userT(ctx.from.id, 'skippedFiles', { count: errors.length }));
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
			await ctx.reply(userT(ctx.from.id, 'filesCleared'));
			await showActionMenu(bot, ctx.chat.id, ctx.from.id);
		})(ctx);
	});

	bot.catch((error) => {
		console.error('Bot error:', error);
	});

	return bot;
}
