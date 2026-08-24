import { getLocaleOverride, setLocaleOverride as persistLocaleOverride } from './prefs.js';

/**
 * User-facing copy. Russian is used when Telegram's language_code starts with `ru`
 * (or after /lang); every other client language falls back to English.
 */
const catalogs = {
	en: {
		start:
			'📁 Upload images or a font — action buttons appear after the upload.\n\n' +
			'<b>📎 Send images as files: tap the paperclip and choose Document.</b>\n\n' +
			'ℹ️ You can send at most 100 files per upload.\n\n' +
			'After upload these buttons are available:\n' +
			'🗜 <b>Minify</b> — any graphics: raster (JPG, PNG, GIF, WebP, ICO) and vector (SVG)\n' +
			'🖼 <b>Minify and convert to WebP</b> — raster is minified and converted to WebP; vector (SVG) is only minified. You can upload raster and vector together.\n' +
			'🔤 <b>Convert to WOFF2</b> — TTF fonts\n' +
			'🗑 <b>Clear</b> — delete all uploaded files',
		uploading: 'Uploading files…',
		batchLimit: 'You can upload at most 100 files at a time.',
		inventoryEmpty:
			'Done. Upload images or a font — action buttons appear after the upload.',
		inventoryLoaded: 'Uploaded ({parts}). Choose an action:',
		kindRaster: 'raster: {count}',
		kindSvg: 'SVG: {count}',
		kindIco: 'ICO: {count}',
		kindTtf: 'TTF: {count}',
		btnWoff2: 'Convert to WOFF2',
		btnMinify: 'Minify',
		btnWebp: 'Minify and convert to WebP',
		btnClear: 'Clear',
		btnClearFiles: 'Clear files',
		quotaExceeded:
			'Storage limit exceeded: your folder has more than 200 MB of files. Tap “Clear files” to delete everything.',
		busy: 'Wait until the current operation finishes.',
		savePhotoFailed: 'Could not save the photo.',
		saveFileFailed: 'Could not save the file.',
		unsupportedType:
			'Supported: JPG, PNG, GIF, WebP, SVG, ICO images and TTF fonts.',
		convertingFonts: 'Converting fonts to WOFF2…',
		minifyingImages: 'Minifying images…',
		convertingWebp: 'Minifying and converting to WebP…',
		skippedFiles: 'Skipped files: {count}.',
		filesCleared: 'All files in your folder have been deleted.',
		processFailed: 'Could not process the files.',
		langPrompt: 'Choose a language:',
		btnLangRu: 'Русский',
		btnLangEn: 'English',
		btnLangAuto: 'Match Telegram',
		langSetRu: 'Language set to Russian.',
		langSetEn: 'Language set to English.',
		langSetAuto: 'Language follows your Telegram app.',
	},
	ru: {
		start:
			'📁 Загрузите изображения или шрифт — после загрузки появятся кнопки действий.\n\n' +
			'<b>📎 Изображения загружайте как файлы: наведите на скрепку и выберите «Документ».</b>\n\n' +
			'ℹ️ За одну загрузку можно отправить не больше 100 файлов.\n\n' +
			'После загрузки доступны кнопки:\n' +
			'🗜 <b>Минифицировать</b> — любая графика: растровая (JPG, PNG, GIF, WebP, ICO) и векторная (SVG)\n' +
			'🖼 <b>Минифицировать и преобразовать в WebP</b> — растр минифицируется и преобразуется в WebP, вектор (SVG) только минифицируется. Растр и вектор можно загрузить вместе.\n' +
			'🔤 <b>Преобразовать в WOFF2</b> — шрифты TTF\n' +
			'🗑 <b>Очистить</b> — удалить все загруженные файлы',
		uploading: 'Загружаю файлы…',
		batchLimit: 'Можно загрузить не более 100 файлов за раз.',
		inventoryEmpty:
			'Успешно. Загрузите изображения или шрифт — после загрузки появятся кнопки действий.',
		inventoryLoaded: 'Загружено ({parts}). Выберите действие:',
		kindRaster: 'растр: {count}',
		kindSvg: 'SVG: {count}',
		kindIco: 'ICO: {count}',
		kindTtf: 'TTF: {count}',
		btnWoff2: 'Преобразовать в WOFF2',
		btnMinify: 'Минифицировать',
		btnWebp: 'Минифицировать и преобразовать в WebP',
		btnClear: 'Очистить',
		btnClearFiles: 'Очистить файлы',
		quotaExceeded:
			'Превышен лимит хранения: в вашей папке больше 200 МБ файлов. Нажмите «Очистить файлы», чтобы удалить всё содержимое.',
		busy: 'Дождитесь окончания текущей операции.',
		savePhotoFailed: 'Не удалось сохранить фото.',
		saveFileFailed: 'Не удалось сохранить файл.',
		unsupportedType:
			'Поддерживаются изображения JPG, PNG, GIF, WebP, SVG, ICO и шрифты TTF.',
		convertingFonts: 'Преобразую шрифты в WOFF2…',
		minifyingImages: 'Минифицирую изображения…',
		convertingWebp: 'Минифицирую и преобразую в WebP…',
		skippedFiles: 'Пропущено файлов: {count}.',
		filesCleared: 'Все файлы в вашей папке удалены.',
		processFailed: 'Не удалось обработать файлы.',
		langPrompt: 'Выберите язык:',
		btnLangRu: 'Русский',
		btnLangEn: 'English',
		btnLangAuto: 'Как в Telegram',
		langSetRu: 'Язык переключён на русский.',
		langSetEn: 'Язык переключён на английский.',
		langSetAuto: 'Язык совпадает с языком Telegram.',
	},
};

/** language_code from the last update; used when the user has not pinned a locale. */
const telegramLanguage = new Map();
/** Pinned locale from disk (`ru` | `en` | null). Lets delayed replies work without `ctx`. */
const localeOverride = new Map();

/** Only `ru*` maps to Russian; missing and non-Russian tags (e.g. `en-US`) map to English. */
export function localeFromTelegram(languageCode) {
	const code = String(languageCode || '').toLowerCase();
	return code.startsWith('ru') ? 'ru' : 'en';
}

/** Look up a catalog string and fill `{name}` placeholders from `params`. */
export function t(locale, key, params = {}) {
	const catalog = catalogs[locale] || catalogs.en;
	const template = catalog[key] ?? catalogs.en[key] ?? key;
	return template.replace(/\{(\w+)\}/g, (_, name) =>
		params[name] == null ? '' : String(params[name]),
	);
}

/**
 * Locale for this user: a /lang pin wins; otherwise Telegram's language_code.
 * Delayed handlers (menu, quota, send) call this with userId only.
 */
export function getLocale(userId) {
	const override = localeOverride.get(Number(userId));
	if (override === 'ru' || override === 'en') {
		return override;
	}
	return localeFromTelegram(telegramLanguage.get(Number(userId)));
}

/**
 * Store language_code from this update. The prefs file is read once per process
 * so a later applyLocaleOverride stays in memory instead of being overwritten.
 */
export async function rememberLocale(userId, languageCode) {
	const id = Number(userId);
	telegramLanguage.set(id, languageCode);
	if (!localeOverride.has(id)) {
		localeOverride.set(id, await getLocaleOverride(id));
	}
}

/** Pin `ru`/`en`, or `null` to follow Telegram again (prefs file is removed). */
export async function applyLocaleOverride(userId, locale) {
	const id = Number(userId);
	const next = locale === 'ru' || locale === 'en' ? locale : null;
	localeOverride.set(id, next);
	await persistLocaleOverride(id, next);
}
