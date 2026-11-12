import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	ALLOWED_SPONSOR_HOSTS,
	ANONYMOUS_NAMES,
	CURRENCY_TO_USD,
	DEFAULT_KOFI_URL,
	extractGitHubHandle,
	isExpired,
	KOFI_TEST_EMAIL_SHA256,
	KOFI_TEST_TRANSACTION_ID,
	KOFI_TIER_PRICES,
	loadSponsorsConfig,
	normalizePlatform,
	parseIsoDatetime,
	Sponsor,
	SponsorsConfig,
	sanitizeSponsorUrl,
	USER_AGENT,
} from "./config.mjs";
import { populateAvatars } from "./providers.mjs";

export function resolveKofiTierDollars(
	tierName,
	amount,
	{ kofiTiers = null, currency = "USD" } = {},
) {
	const tiers = kofiTiers || KOFI_TIER_PRICES;
	const cleanTier = String(tierName || "")
		.trim()
		.toLowerCase();
	if (cleanTier && cleanTier in tiers) {
		return tiers[cleanTier];
	}
	const match = String(tierName || "").match(/\$\s*(\d+(?:\.\d+)?)/);
	if (match) {
		return Math.trunc(Number(match[1]));
	}
	const numericAmount = Number(amount ?? 0);
	if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
		return 0;
	}
	const currKey = String(currency || "USD")
		.trim()
		.toUpperCase();
	const rate = CURRENCY_TO_USD[currKey] ?? 1.0;
	const usd = numericAmount * rate;
	if (usd >= 0.5 && usd < 1) {
		return 1;
	}
	return Math.trunc(Math.round(usd));
}

export function parseExtraEntries(raw) {
	if (Array.isArray(raw)) {
		return raw.filter(
			(item) => item && typeof item === "object" && !Array.isArray(item),
		);
	}
	if (raw && typeof raw === "object" && Array.isArray(raw.sponsors)) {
		return raw.sponsors.filter(
			(item) => item && typeof item === "object" && !Array.isArray(item),
		);
	}
	return [];
}

export function isAnonymousName(name) {
	const cleaned = String(name || "")
		.trim()
		.toLowerCase();
	return !cleaned || ANONYMOUS_NAMES.has(cleaned);
}

function recordPriority(item, { kofiTiers = null } = {}) {
	const oneTime = Boolean(item.is_one_time);
	const dollars = resolveKofiTierDollars(
		String(item.tier_name || item.tier || ""),
		item.monthly_dollars ?? item.amount ?? 0,
		{ kofiTiers, currency: item.currency || "USD" },
	);
	return [oneTime ? 0 : 1, dollars];
}

function comparePriority(a, b) {
	if (a[0] !== b[0]) return a[0] - b[0];
	return a[1] - b[1];
}

export function collectActiveRecords(
	entries,
	{ now = null, defaultKofiUrl = DEFAULT_KOFI_URL, config = null } = {},
) {
	const cfg = config || new SponsorsConfig();
	const active = new Map();
	for (const item of entries || []) {
		const expiresAt = String(item.expires_at || "").trim();
		if (expiresAt && isExpired(expiresAt, now)) continue;
		const platform = normalizePlatform(item.platform);
		const login = String(
			item.login || item.handle || item.name || "",
		).trim();
		if (!login) continue;
		const url = sanitizeSponsorUrl(String(item.url || ""), platform, login, {
			defaultKofiUrl,
			allowedHosts: cfg.allowed_hosts,
		});
		if (isAnonymousName(login) && url === defaultKofiUrl) continue;

		const key = `${platform}:${login.toLowerCase()}`;
		const prev = active.get(key);
		if (
			!prev ||
			comparePriority(
				recordPriority(item, { kofiTiers: cfg.kofi_tiers }),
				recordPriority(prev, { kofiTiers: cfg.kofi_tiers }),
			) >= 0
		) {
			active.set(key, item);
		}
	}
	return active;
}

function sortExtraRecords(records) {
	return [...records].sort((a, b) => {
		const aOne = a.is_one_time ? 1 : 0;
		const bOne = b.is_one_time ? 1 : 0;
		if (aOne !== bOne) return aOne - bOne;
		const aDol = Math.trunc(Number(a.monthly_dollars || 0));
		const bDol = Math.trunc(Number(b.monthly_dollars || 0));
		if (bDol !== aDol) return bDol - aDol;
		return String(a.login || "")
			.toLowerCase()
			.localeCompare(String(b.login || "").toLowerCase());
	});
}

function recordToSponsor(item, { defaultKofiUrl, cfg }) {
	const platform = normalizePlatform(item.platform);
	const login = String(item.login || item.handle || item.name || "").trim();
	const name = String(item.name || login).trim();
	const tierName = String(item.tier_name || item.tier || "").trim();
	const monthly = resolveKofiTierDollars(
		tierName,
		item.monthly_dollars ?? item.amount ?? 0,
		{ kofiTiers: cfg.kofi_tiers, currency: item.currency || "USD" },
	);
	const isOneTime = Boolean(item.is_one_time);
	const avatarUrl = String(item.avatar_url || "").trim();
	const url = sanitizeSponsorUrl(String(item.url || ""), platform, login, {
		defaultKofiUrl,
		allowedHosts: cfg.allowed_hosts,
	});
	const avatarDataUri = String(item.avatar_data_uri || "").trim();

	return new Sponsor({
		login,
		name,
		avatar_url: avatarUrl,
		url,
		monthly_dollars: monthly,
		is_one_time: isOneTime,
		avatar_data_uri: avatarDataUri,
		platform,
	});
}

export async function loadExtraSponsors(
	extraPath = null,
	extraEnv = null,
	{
		extraPaths = null,
		now = null,
		defaultKofiUrl = DEFAULT_KOFI_URL,
		config = null,
		fetchAvatars = true,
		fetchImpl = globalThis.fetch,
	} = {},
) {
	const rawEntries = [];
	const pathsToLoad = [];
	if (extraPath) pathsToLoad.push(extraPath);
	for (const p of extraPaths || []) {
		if (p && !pathsToLoad.includes(p)) pathsToLoad.push(p);
	}

	const cfg =
		config || loadSponsorsConfig(pathsToLoad.length > 0 ? pathsToLoad[0] : null);

	for (const p of pathsToLoad) {
		if (existsSync(p)) {
			rawEntries.push(
				...parseExtraEntries(JSON.parse(readFileSync(p, "utf-8"))),
			);
		}
	}

	const envPayload = (
		extraEnv !== null ? extraEnv : process.env.EXTRA_SPONSORS_JSON || ""
	).trim();
	if (envPayload && envPayload !== "null") {
		rawEntries.push(...parseExtraEntries(JSON.parse(envPayload)));
	}

	const activeRecords = collectActiveRecords(rawEntries, {
		now,
		defaultKofiUrl,
		config: cfg,
	});
	const sponsors = Array.from(activeRecords.values(), (item) =>
		recordToSponsor(item, { defaultKofiUrl, cfg }),
	);
	if (!fetchAvatars) return sponsors;
	return populateAvatars(sponsors, {
		featuredThreshold: cfg.featured_threshold,
		tiers: cfg.tiers,
		fetchImpl,
	});
}

async function lookupRobloxIdByUsername(username, fetchImpl) {
	const resp = await fetchImpl("https://users.roblox.com/v1/usernames/users", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": USER_AGENT,
		},
		body: JSON.stringify({
			usernames: [username],
			excludeBannedUsers: true,
		}),
		signal: AbortSignal.timeout(10000),
	});
	const data = (await resp.json())?.data || [];
	if (!data.length) return ["", username];
	return [String(data[0].id || ""), String(data[0].name || username)];
}

async function lookupRobloxNameById(userId, fetchImpl) {
	const resp = await fetchImpl(
		`https://users.roblox.com/v1/users/${encodeURIComponent(userId)}`,
		{
			headers: { "User-Agent": USER_AGENT },
			signal: AbortSignal.timeout(10000),
		},
	);
	const info = await resp.json();
	return String(info?.name || `roblox-${userId}`);
}

export async function resolveRobloxProfile(
	{ username = null, userId = null } = {},
	{ fetchImpl = globalThis.fetch } = {},
) {
	let resolvedId = userId ? String(userId) : "";
	let resolvedLogin = username ? String(username) : "";
	try {
		if (!resolvedId && resolvedLogin) {
			[resolvedId, resolvedLogin] = await lookupRobloxIdByUsername(
				resolvedLogin,
				fetchImpl,
			);
		} else if (resolvedId && !resolvedLogin) {
			resolvedLogin = await lookupRobloxNameById(resolvedId, fetchImpl);
		}
		if (!resolvedId) return null;

		const thumbUrl = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(resolvedId)}&size=150x150&format=Png&isCircular=false`;
		const thumbResp = await fetchImpl(thumbUrl, {
			headers: { "User-Agent": USER_AGENT },
			signal: AbortSignal.timeout(10000),
		});
		const tdata = (await thumbResp.json())?.data || [];
		const avatarUrl = tdata.length ? String(tdata[0].imageUrl || "") : "";
		return [
			resolvedLogin || `roblox-${resolvedId}`,
			avatarUrl,
			`https://www.roblox.com/users/${resolvedId}/profile`,
		];
	} catch (err) {
		process.stderr.write(
			`warning: failed to resolve Roblox profile (${username || userId}): ${err}\n`,
		);
	}
	return null;
}

export async function probeGravatarUrl(
	emailSha256,
	{ fetchImpl = globalThis.fetch } = {},
) {
	const cleanHash = String(emailSha256 || "")
		.trim()
		.toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(cleanHash)) return "";
	const url = `https://www.gravatar.com/avatar/${cleanHash}?s=160&d=404`;
	try {
		const resp = await fetchImpl(url, {
			method: "HEAD",
			headers: { "User-Agent": USER_AGENT },
			signal: AbortSignal.timeout(8000),
		});
		if (resp.status >= 200 && resp.status < 300) {
			return url;
		}
	} catch {
		// Gravatar not found or offline
	}
	return "";
}

export function extractRobloxTag(combined) {
	const rblxUrlMatch = String(combined || "").match(
		/(?:https?:\/\/)?(?:www\.)?roblox\.com\/users\/(\d+)/i,
	);
	if (rblxUrlMatch) {
		return ["", rblxUrlMatch[1]];
	}

	const rblxTagMatch = String(combined || "").match(
		/(?:^|[\s(\[])(?:roblox|rblx)\s*:\s*@?([A-Za-z0-9_]{3,20})\b/i,
	);
	if (rblxTagMatch) {
		return [rblxTagMatch[1], ""];
	}
	return ["", ""];
}

export function cleanDisplayName(fromName) {
	let cleaned = String(fromName || "").replace(/https?:\/\/\S+/g, "");
	cleaned = cleaned.replace(
		/\(\s*(?:github\s*:\s*@?|gh\s*:\s*@?|roblox\s*:\s*@?|rblx\s*:\s*@?|@)[A-Za-z0-9_-]+\s*\)/gi,
		"",
	);
	cleaned = cleaned.replace(
		/(?:^|[\s(\[])(?:github\s*:\s*@?|gh\s*:\s*@?|roblox\s*:\s*@?|rblx\s*:\s*@?|@)[A-Za-z0-9_-]+/gi,
		"",
	);
	return cleaned.replace(/^[\s\-·()[\]]+|[\s\-·()[\]]+$/g, "");
}

export async function extractSponsorIdentity(
	fromName,
	message,
	{
		email = "",
		emailSha256 = "",
		networkLookup = true,
		defaultKofiUrl = DEFAULT_KOFI_URL,
		allowedHosts = ALLOWED_SPONSOR_HOSTS,
		fetchImpl = globalThis.fetch,
	} = {},
) {
	const combined = `${fromName || ""}\n${message || ""}`;
	const ghUser = extractGitHubHandle(combined);
	const [rblxUser, rblxId] = extractRobloxTag(combined);
	const cleanDisplay = cleanDisplayName(fromName);

	let login = cleanDisplay;
	let displayName = cleanDisplay;
	let avatarUrl = "";
	let profileUrl = defaultKofiUrl;

	if (ghUser) {
		login = ghUser;
		if (
			isAnonymousName(cleanDisplay) ||
			cleanDisplay.toLowerCase() === ghUser.toLowerCase()
		) {
			displayName = ghUser;
		}
		avatarUrl = `https://github.com/${encodeURIComponent(ghUser)}.png?size=160`;
		profileUrl = `https://github.com/${encodeURIComponent(ghUser)}`;
	} else if (rblxUser || rblxId) {
		const resolved = networkLookup
			? await resolveRobloxProfile(
					{ username: rblxUser || null, userId: rblxId || null },
					{ fetchImpl },
				)
			: null;
		if (resolved) {
			[login, avatarUrl, profileUrl] = resolved;
		} else {
			login = rblxUser || `roblox-${rblxId}`;
			if (rblxId) {
				profileUrl = `https://www.roblox.com/users/${rblxId}/profile`;
			}
		}
		if (isAnonymousName(cleanDisplay)) {
			displayName = login;
		}
	} else if (isAnonymousName(cleanDisplay)) {
		return ["", "", "", defaultKofiUrl];
	}

	if (!avatarUrl && networkLookup) {
		let digest = String(emailSha256 || "")
			.trim()
			.toLowerCase();
		if (!digest && String(email || "").trim()) {
			digest = createHash("sha256")
				.update(String(email).trim().toLowerCase())
				.digest("hex");
		}
		if (digest) {
			avatarUrl = await probeGravatarUrl(digest, { fetchImpl });
		}
	}

	const sanitizedUrl = sanitizeSponsorUrl(profileUrl, "kofi", login, {
		defaultKofiUrl,
		allowedHosts,
	});
	return [login, displayName, avatarUrl, sanitizedUrl];
}

function writeSponsorsDoc(sponsorsPath, sortedRecords) {
	const topLevel = {};
	if (existsSync(sponsorsPath)) {
		const rawDoc = JSON.parse(readFileSync(sponsorsPath, "utf-8"));
		if (rawDoc && typeof rawDoc === "object" && !Array.isArray(rawDoc)) {
			for (const [k, v] of Object.entries(rawDoc)) {
				if (k !== "sponsors") topLevel[k] = v;
			}
		}
	}
	const doc = { ...topLevel, sponsors: sortedRecords };
	const formatted = `${JSON.stringify(doc, null, 2)}\n`;
	mkdirSync(dirname(sponsorsPath), { recursive: true });
	if (
		!existsSync(sponsorsPath) ||
		readFileSync(sponsorsPath, "utf-8") !== formatted
	) {
		writeFileSync(sponsorsPath, formatted, "utf-8");
	}
}

export function pruneExtraSponsorsFile(
	sponsorsPath,
	{ now = null, defaultKofiUrl = DEFAULT_KOFI_URL, config = null } = {},
) {
	if (!sponsorsPath || !existsSync(sponsorsPath)) return [];
	const cfg = config || loadSponsorsConfig(sponsorsPath);
	const rawDoc = JSON.parse(readFileSync(sponsorsPath, "utf-8"));
	const activeByKey = collectActiveRecords(parseExtraEntries(rawDoc), {
		now,
		defaultKofiUrl,
		config: cfg,
	});
	const sortedRecords = sortExtraRecords(activeByKey.values());
	writeSponsorsDoc(sponsorsPath, sortedRecords);
	return sortedRecords;
}

function findMatchingKofiRecord(activeByKey, login, emailSha256) {
	const directKey = `kofi:${login.toLowerCase()}`;
	if (activeByKey.has(directKey)) {
		return [directKey, activeByKey.get(directKey)];
	}
	if (emailSha256) {
		for (const [existingKey, entry] of activeByKey.entries()) {
			if (
				existingKey.startsWith("kofi:") &&
				String(entry.email_sha256 || "").toLowerCase() === emailSha256
			) {
				return [existingKey, entry];
			}
		}
	}
	return [directKey, null];
}

function formatUtcIso(dt) {
	return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function mergePrevKofiRecord(
	prev,
	{
		login,
		displayName,
		dollars,
		isOneTime,
		tierName,
		avatarUrl,
		profileUrl,
		expiresDt,
		defaultKofiUrl,
		cfg,
	},
) {
	const prevLogin = String(prev.login || login).trim();
	if (
		profileUrl === defaultKofiUrl &&
		prevLogin.toLowerCase() !== login.toLowerCase()
	) {
		login = prevLogin;
	}

	const prevOneTime = Boolean(prev.is_one_time);
	const prevDollars = resolveKofiTierDollars(
		String(prev.tier_name || prev.tier || ""),
		prev.monthly_dollars ?? prev.amount ?? 0,
		{ kofiTiers: cfg.kofi_tiers, currency: prev.currency || "USD" },
	);
	const prevExpires = parseIsoDatetime(String(prev.expires_at || ""));
	if (prevExpires && prevExpires.getTime() > expiresDt.getTime()) {
		expiresDt = prevExpires;
	}

	if (!prevOneTime && isOneTime) {
		isOneTime = false;
		dollars = Math.max(prevDollars, 1);
		if (!tierName && prev.tier_name) {
			tierName = String(prev.tier_name);
		}
	} else if (prevOneTime && isOneTime) {
		dollars = prevDollars + dollars;
	}

	if (!avatarUrl && prev.avatar_url) {
		avatarUrl = String(prev.avatar_url);
	}
	const prevUrl = sanitizeSponsorUrl(String(prev.url || ""), "kofi", login, {
		defaultKofiUrl,
		allowedHosts: cfg.allowed_hosts,
	});
	if (profileUrl === defaultKofiUrl && prevUrl !== defaultKofiUrl) {
		profileUrl = prevUrl;
	}
	const prevName = String(prev.name || "").trim();
	if (
		prevName &&
		displayName.toLowerCase() === login.toLowerCase() &&
		prevName.toLowerCase() !== login.toLowerCase()
	) {
		displayName = prevName;
	}

	return [
		login,
		displayName,
		dollars,
		isOneTime,
		tierName,
		avatarUrl,
		profileUrl,
		formatUtcIso(expiresDt),
	];
}

function parseKofiEventFields(payload, { kofiTiers = null } = {}) {
	if (payload.is_public === false) {
		process.stderr.write("Skipping non-public Ko-fi event\n");
		return null;
	}

	const txId = String(payload.kofi_transaction_id || "").trim();
	const messageId = String(payload.message_id || "").trim();
	const email = String(payload.email || "").trim();
	let emailSha256 = String(payload.email_sha256 || "")
		.trim()
		.toLowerCase();
	if (!emailSha256 && email) {
		emailSha256 = createHash("sha256")
			.update(email.toLowerCase())
			.digest("hex");
	}

	if (
		txId === KOFI_TEST_TRANSACTION_ID ||
		emailSha256 === KOFI_TEST_EMAIL_SHA256
	) {
		process.stderr.write("Skipping Ko-fi test webhook payload\n");
		return null;
	}

	const tierName = String(payload.tier_name || "").trim();
	const amount = payload.amount ?? payload.monthly_dollars ?? 0;
	const currency = String(payload.currency || "USD").trim();
	const dollars = resolveKofiTierDollars(tierName, amount, {
		kofiTiers,
		currency,
	});
	if (dollars < 1) {
		process.stderr.write(
			`Skipping Ko-fi event with amount < $1 (${amount} ${currency})\n`,
		);
		return null;
	}

	const eventType = String(payload.type || "")
		.trim()
		.toLowerCase();
	const isOneTime = !(
		Boolean(payload.is_subscription_payment) ||
		Boolean(tierName) ||
		eventType === "subscription"
	);
	return [txId || messageId, emailSha256, tierName, dollars, isOneTime];
}

function buildKofiRecord({
	login,
	displayName,
	dollars,
	isOneTime,
	profileUrl,
	expiresAt,
	tierName,
	avatarUrl,
	emailSha256,
	prevEventIds,
	eventId,
}) {
	const rec = {
		platform: "kofi",
		login,
		name: displayName,
		monthly_dollars: dollars,
		is_one_time: isOneTime,
		url: profileUrl,
		expires_at: expiresAt,
	};
	if (tierName) rec.tier_name = tierName;
	if (avatarUrl) rec.avatar_url = avatarUrl;
	if (emailSha256) rec.email_sha256 = emailSha256;
	const updatedEventIds = [
		...prevEventIds,
		...(eventId ? [eventId] : []),
	].slice(-20);
	if (updatedEventIds.length > 0) rec.event_ids = updatedEventIds;
	return rec;
}

function upsertKofiRecord(
	sponsorsPath,
	{
		refNow,
		defaultKofiUrl,
		cfg,
		login,
		displayName,
		dollars,
		isOneTime,
		tierName,
		avatarUrl,
		profileUrl,
		expiresDt,
		emailSha256,
		eventId,
	},
) {
	const existingEntries = pruneExtraSponsorsFile(sponsorsPath, {
		now: refNow,
		defaultKofiUrl,
		config: cfg,
	});
	const activeByKey = collectActiveRecords(existingEntries, {
		now: refNow,
		defaultKofiUrl,
		config: cfg,
	});
	const [matchedKey, prev] = findMatchingKofiRecord(
		activeByKey,
		login,
		emailSha256,
	);
	const prevEventIds = Array.isArray(prev?.event_ids)
		? prev.event_ids.filter(Boolean).map(String)
		: [];
	if (eventId && prevEventIds.includes(eventId)) {
		process.stderr.write(`Skipping duplicate Ko-fi event (${eventId})\n`);
		return false;
	}
	let expiresAt = formatUtcIso(expiresDt);
	if (prev) {
		activeByKey.delete(matchedKey);
		emailSha256 ||= String(prev.email_sha256 || "")
			.trim()
			.toLowerCase();
		[
			login,
			displayName,
			dollars,
			isOneTime,
			tierName,
			avatarUrl,
			profileUrl,
			expiresAt,
		] = mergePrevKofiRecord(prev, {
			login,
			displayName,
			dollars,
			isOneTime,
			tierName,
			avatarUrl,
			profileUrl,
			expiresDt,
			defaultKofiUrl,
			cfg,
		});
	}
	activeByKey.set(
		`kofi:${login.toLowerCase()}`,
		buildKofiRecord({
			login,
			displayName,
			dollars,
			isOneTime,
			profileUrl,
			expiresAt,
			tierName,
			avatarUrl,
			emailSha256,
			prevEventIds,
			eventId,
		}),
	);
	writeSponsorsDoc(sponsorsPath, sortExtraRecords(activeByKey.values()));
	return true;
}

export async function ingestKofiPayload(
	payload,
	sponsorsPath,
	{
		now = null,
		networkLookup = true,
		defaultKofiUrl = DEFAULT_KOFI_URL,
		config = null,
		fetchImpl = globalThis.fetch,
	} = {},
) {
	if (!payload || typeof payload !== "object") return false;
	const rawPayload =
		payload.kofi && typeof payload.kofi === "object" ? payload.kofi : payload;
	const cfg = config || loadSponsorsConfig(sponsorsPath);
	const parsed = parseKofiEventFields(rawPayload, {
		kofiTiers: cfg.kofi_tiers,
	});
	if (!parsed) return false;
	const [eventId, emailSha256, tierName, dollars, isOneTime] = parsed;
	const [login, displayName, avatarUrl, profileUrl] =
		await extractSponsorIdentity(
			String(rawPayload.from_name || rawPayload.name || "").trim(),
			String(rawPayload.message || "").trim(),
			{
				emailSha256,
				networkLookup,
				defaultKofiUrl,
				allowedHosts: cfg.allowed_hosts,
				fetchImpl,
			},
		);
	if (!login) {
		process.stderr.write("Skipping anonymous/unidentified Ko-fi event\n");
		return false;
	}
	const refNow = now instanceof Date ? now : new Date();
	const eventDt =
		parseIsoDatetime(String(rawPayload.timestamp || "")) || refNow;
	const expiresDt = new Date(
		Math.max(eventDt.getTime(), refNow.getTime()) +
			cfg.active_window_days * 86400000,
	);
	return upsertKofiRecord(sponsorsPath, {
		refNow,
		defaultKofiUrl,
		cfg,
		login,
		displayName,
		dollars,
		isOneTime,
		tierName,
		avatarUrl,
		profileUrl,
		expiresDt,
		emailSha256,
		eventId,
	});
}
