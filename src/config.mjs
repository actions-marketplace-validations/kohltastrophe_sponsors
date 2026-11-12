import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const GRAPHQL_URL = "https://api.github.com/graphql";
export const OPENCOLLECTIVE_GRAPHQL_URL =
	"https://api.opencollective.com/graphql/v2";
export const USER_AGENT = "github-sponsors-svg/1.0";
export const DEFAULT_FUNDING_PATH = ".github/FUNDING.yml";
export const DEFAULT_EXTRA_PATH = ".github/sponsors.json";
export const DEFAULT_KOFI_URL = "https://ko-fi.com";
export const FEATURED_THRESHOLD = 25;
export const ACTIVE_WINDOW_DAYS = 35;

export const PLATFORMS = Object.freeze({
	GITHUB: "github",
	KOFI: "kofi",
	OPENCOLLECTIVE: "opencollective",
	POLAR: "polar",
	PATREON: "patreon",
});

export const KOFI_TIER_PRICES = Object.freeze({
	"$1 a month": 1,
	"$5 a month": 5,
	"$25 a month": 25,
	supporter: 1,
	backer: 5,
	featured: 25,
	"featured sponsor": 25,
});

export const CURRENCY_TO_USD = Object.freeze({
	USD: 1.0,
	EUR: 1.08,
	GBP: 1.27,
	CAD: 0.73,
	AUD: 0.66,
	NZD: 0.6,
	CHF: 1.13,
	SGD: 0.74,
	HKD: 0.13,
	SEK: 0.095,
	NOK: 0.092,
	DKK: 0.145,
	PLN: 0.25,
	BRL: 0.18,
	MXN: 0.05,
	TWD: 0.031,
	INR: 0.012,
	JPY: 0.0067,
	KRW: 0.00073,
});

export const TIER_PRESETS = Object.freeze({
	xs: Object.freeze({
		avatar_size: 36,
		cell_w: 64,
		cell_h: 62,
		cols: 10,
		featured: false,
		max_chars: 10,
	}),
	sm: Object.freeze({
		avatar_size: 42,
		cell_w: 72,
		cell_h: 70,
		cols: 9,
		featured: false,
		max_chars: 11,
	}),
	base: Object.freeze({
		avatar_size: 46,
		cell_w: 76,
		cell_h: 74,
		cols: 9,
		featured: false,
		max_chars: 12,
	}),
	md: Object.freeze({
		avatar_size: 54,
		cell_w: 86,
		cell_h: 82,
		cols: 8,
		featured: true,
		max_chars: 13,
	}),
	lg: Object.freeze({
		avatar_size: 64,
		cell_w: 96,
		cell_h: 92,
		cols: 7,
		featured: true,
		max_chars: 14,
	}),
	xl: Object.freeze({
		avatar_size: 76,
		cell_w: 112,
		cell_h: 106,
		cols: 6,
		featured: true,
		max_chars: 16,
	}),
});

export const EMAIL_DOMAINS_IGNORE = new Set([
	"gmail",
	"googlemail",
	"yahoo",
	"outlook",
	"hotmail",
	"icloud",
	"proton",
	"protonmail",
	"aol",
	"live",
	"msn",
	"kofi",
	"ko-fi",
]);

export const ANONYMOUS_NAMES = new Set([
	"anonymous",
	"someone",
	"supporter",
	"a supporter",
	"anon",
	"unknown",
	"private",
	"n/a",
	"none",
]);

export const ALLOWED_SPONSOR_HOSTS = new Set([
	"github.com",
	"www.github.com",
	"roblox.com",
	"www.roblox.com",
	"ko-fi.com",
	"www.ko-fi.com",
	"opencollective.com",
	"www.opencollective.com",
]);

export const KOFI_TEST_TRANSACTION_ID = "00000000-1111-2222-3333-444444444444";
export const KOFI_TEST_EMAIL = "jo.example@example.com";
export const KOFI_TEST_EMAIL_SHA256 = createHash("sha256")
	.update(KOFI_TEST_EMAIL)
	.digest("hex");

/** Reads a GitHub Action input from `INPUT_FOO-BAR` (`node24`) or `INPUT_FOO_BAR`. */
export function getInput(name) {
	const upper = name.toUpperCase();
	const hyphenVal = process.env[`INPUT_${upper}`];
	if (typeof hyphenVal === "string" && hyphenVal.trim() !== "") {
		return hyphenVal.trim();
	}
	const underscoreVal = process.env[`INPUT_${upper.replaceAll("-", "_")}`];
	if (typeof underscoreVal === "string") {
		return underscoreVal.trim();
	}
	return typeof hyphenVal === "string" ? hyphenVal.trim() : "";
}

export class Sponsor {
	constructor({
		login,
		name,
		avatar_url = "",
		url = "",
		monthly_dollars = 0,
		is_one_time = false,
		avatar_data_uri = "",
		platform = "github",
		tier_unknown = false,
		is_past = false,
	}) {
		this.login = String(login || "").trim();
		this.name = String(name || this.login).trim();
		this.avatar_url = String(avatar_url || "").trim();
		this.url = String(url || "").trim();
		this.monthly_dollars = Number(monthly_dollars || 0);
		this.is_one_time = Boolean(is_one_time);
		this.avatar_data_uri = String(avatar_data_uri || "").trim();
		this.platform = String(platform || "github").trim();
		this.tier_unknown = Boolean(tier_unknown);
		this.is_past = Boolean(is_past);
		Object.freeze(this);
	}
}

export class SponsorsConfig {
	constructor({
		featured_threshold = FEATURED_THRESHOLD,
		active_window_days = ACTIVE_WINDOW_DAYS,
		kofi_tiers = { ...KOFI_TIER_PRICES },
		allowed_hosts = new Set(ALLOWED_SPONSOR_HOSTS),
		exclude = new Set(),
		overrides = {},
		tiers = null,
		include_past = false,
	} = {}) {
		this.featured_threshold = Number(featured_threshold);
		this.active_window_days = Number(active_window_days);
		this.kofi_tiers = { ...kofi_tiers };
		this.allowed_hosts =
			allowed_hosts instanceof Set
				? new Set(allowed_hosts)
				: new Set(allowed_hosts || ALLOWED_SPONSOR_HOSTS);
		this.exclude = new Set(
			Array.from(exclude || [], (x) => String(x).trim().toLowerCase()).filter(
				Boolean,
			),
		);
		this.overrides = { ...(overrides || {}) };
		this.tiers = Array.isArray(tiers) ? tiers : null;
		this.include_past = Boolean(include_past);
		Object.freeze(this);
	}
}

export function expandAllowedHosts(hosts) {
	const merged = new Set(ALLOWED_SPONSOR_HOSTS);
	for (const raw of hosts || []) {
		const host = String(raw || "")
			.trim()
			.toLowerCase()
			.replace(/^https?:\/\//, "")
			.replace(/\/+$/, "");
		if (host) {
			merged.add(host);
			if (!host.startsWith("www.")) {
				merged.add(`www.${host}`);
			}
		}
	}
	return merged;
}

function addNormalizedItems(targetSet, items) {
	for (const item of items || []) {
		const clean = String(item || "")
			.trim()
			.toLowerCase();
		if (clean) targetSet.add(clean);
	}
}

function mergeTierPrices(targetTiers, rawTiers) {
	if (!rawTiers || typeof rawTiers !== "object") return;
	for (const [k, v] of Object.entries(rawTiers)) {
		targetTiers[String(k).trim().toLowerCase()] = Math.trunc(Number(v));
	}
}

function readRawSponsorsConfigDoc(configPath) {
	if (!configPath || !existsSync(configPath)) return null;
	const rawDoc = JSON.parse(readFileSync(configPath, "utf-8"));
	return rawDoc && typeof rawDoc === "object" && !Array.isArray(rawDoc)
		? rawDoc
		: null;
}

export function loadSponsorsConfig(
	configPath = null,
	{
		featuredThreshold = null,
		activeWindowDays = null,
		exclude = null,
		includePast = null,
	} = {},
) {
	const rawDoc = readRawSponsorsConfigDoc(configPath);
	const mergedTiers = { ...KOFI_TIER_PRICES };
	mergeTierPrices(mergedTiers, rawDoc?.kofi_tiers);

	const envTiers = (process.env.SPONSORS_KOFI_TIERS || "").trim();
	if (envTiers) mergeTierPrices(mergedTiers, JSON.parse(envTiers));

	const mergedHosts = Array.isArray(rawDoc?.allowed_hosts)
		? expandAllowedHosts(rawDoc.allowed_hosts)
		: new Set(ALLOWED_SPONSOR_HOSTS);
	const envHosts = (process.env.SPONSORS_ALLOWED_HOSTS || "").trim();
	if (envHosts) {
		for (const h of expandAllowedHosts(envHosts.split(","))) mergedHosts.add(h);
	}

	const mergedExclude = new Set();
	if (Array.isArray(rawDoc?.exclude)) {
		addNormalizedItems(mergedExclude, rawDoc.exclude);
	}
	const envExclude = (
		process.env.SPONSORS_EXCLUDE ||
		getInput("exclude") ||
		""
	).trim();
	if (envExclude) addNormalizedItems(mergedExclude, envExclude.split(","));
	if (Array.isArray(exclude)) addNormalizedItems(mergedExclude, exclude);

	const mergedOverrides = {};
	if (rawDoc?.overrides && typeof rawDoc.overrides === "object") {
		for (const [k, v] of Object.entries(rawDoc.overrides)) {
			if (v && typeof v === "object") {
				mergedOverrides[String(k).trim().toLowerCase()] = v;
			}
		}
	}

	const envThreshold = (
		process.env.SPONSORS_FEATURED_THRESHOLD || getInput("featured-threshold")
	).trim();
	const envWindow = (
		process.env.SPONSORS_ACTIVE_WINDOW_DAYS || getInput("active-window-days")
	).trim();
	const envIncludePast = (
		process.env.SPONSORS_INCLUDE_PAST || getInput("include-past")
	)
		.trim()
		.toLowerCase();

	const resolvedThreshold = Math.trunc(
		Number(
			featuredThreshold ??
				(envThreshold || rawDoc?.featured_threshold || FEATURED_THRESHOLD),
		),
	);
	const resolvedWindow = Math.trunc(
		Number(
			activeWindowDays ??
				(envWindow || rawDoc?.active_window_days || ACTIVE_WINDOW_DAYS),
		),
	);
	const resolvedIncludePast =
		includePast != null
			? Boolean(includePast)
			: envIncludePast === "true" ||
				envIncludePast === "1" ||
				Boolean(rawDoc?.include_past);

	return new SponsorsConfig({
		featured_threshold: resolvedThreshold,
		active_window_days: resolvedWindow,
		kofi_tiers: mergedTiers,
		allowed_hosts: mergedHosts,
		exclude: mergedExclude,
		overrides: mergedOverrides,
		tiers: Array.isArray(rawDoc?.tiers) ? rawDoc.tiers : null,
		include_past: resolvedIncludePast,
	});
}

function detectGitHubOwnerFromGit(repoDir = process.cwd()) {
	try {
		const stdout = execFileSync("git", ["remote", "get-url", "origin"], {
			cwd: repoDir,
			timeout: 10000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const match = stdout.match(/github\.com[:/]([^/\s]+)\//i);
		if (match) return match[1].trim();
	} catch {
		// No git remote configured
	}
	return "";
}

export function parseFundingFile(fundingPath) {
	const result = {
		github: "",
		ko_fi: "",
		open_collective: "",
		polar: "",
		patreon: "",
		buy_me_a_coffee: "",
		liberapay: "",
		platforms: [],
	};
	if (!fundingPath || !existsSync(fundingPath)) {
		return result;
	}

	let currentKey = "";
	for (const rawLine of readFileSync(fundingPath, "utf-8").split(/\r?\n/)) {
		const line = rawLine.split("#", 1)[0].trim();
		if (!line) continue;

		if (line.startsWith("-") && currentKey) {
			const itemVal = line
				.slice(1)
				.trim()
				.replace(/^['"]|['"]$/g, "");
			if (itemVal && currentKey in result && !result[currentKey]) {
				result[currentKey] = itemVal;
				if (!result.platforms.includes(currentKey)) {
					result.platforms.push(currentKey);
				}
			}
			continue;
		}

		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim().toLowerCase();
		const rawVal = line.slice(colonIdx + 1).trim();
		currentKey = key;
		if (!rawVal) continue;

		const val = rawVal
			.replace(/^\[|\]$/g, "")
			.split(",", 1)[0]
			.trim()
			.replace(/^['"]|['"]$/g, "");
		if (val && key in result && !result[key]) {
			result[key] = val;
			if (!result.platforms.includes(key)) {
				result.platforms.push(key);
			}
		}
	}
	return result;
}

export function loadFundingDefaults(
	fundingPath = DEFAULT_FUNDING_PATH,
	repoDir = null,
) {
	const envGh = (process.env.GITHUB_LOGIN || getInput("login")).trim();
	const envKofi = (process.env.KOFI_HANDLE || getInput("kofi")).trim();
	const envOc = (
		process.env.OPENCOLLECTIVE_SLUG || getInput("opencollective")
	).trim();

	let envOwner = (process.env.GITHUB_REPOSITORY_OWNER || "").trim();
	if (!envOwner) {
		const repoEnv = (process.env.GITHUB_REPOSITORY || "").trim();
		if (repoEnv.includes("/")) {
			envOwner = repoEnv.split("/", 1)[0].trim();
		}
	}

	const parsed = parseFundingFile(fundingPath);
	const resolvedDir =
		repoDir || (fundingPath ? dirname(dirname(resolve(fundingPath))) : ".");
	const resolvedGh =
		envGh ||
		parsed.github ||
		detectGitHubOwnerFromGit(resolvedDir) ||
		envOwner;
	const resolvedKofi = envKofi || parsed.ko_fi || resolvedGh;
	const resolvedOc = envOc || parsed.open_collective || "";

	const tuple = [resolvedGh, resolvedKofi];
	tuple.github = resolvedGh;
	tuple.kofi = resolvedKofi;
	tuple.open_collective = resolvedOc;
	tuple.polar = parsed.polar;
	tuple.patreon = parsed.patreon;
	tuple.platforms = parsed.platforms;
	return tuple;
}

export function kofiProfileUrl(kofiHandle = "") {
	const clean = String(kofiHandle || "")
		.trim()
		.replace(/^\/+|\/+$/g, "");
	if (clean.startsWith("https://") || clean.startsWith("http://")) {
		return clean;
	}
	return clean ? `https://ko-fi.com/${clean}` : DEFAULT_KOFI_URL;
}

export function parseIsoDatetime(value) {
	const raw = String(value || "").trim();
	if (!raw) return null;
	const normalized = /Z$|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`;
	const ms = Date.parse(normalized);
	return Number.isNaN(ms) ? null : new Date(ms);
}

export function isExpired(expiresAt, now = null) {
	const dt = parseIsoDatetime(expiresAt);
	if (!dt) return false;
	const ref = now instanceof Date ? now : new Date();
	return dt.getTime() <= ref.getTime();
}

export function normalizePlatform(raw) {
	const clean = String(raw || "kofi")
		.trim()
		.toLowerCase();
	if (clean === "kofi" || clean === "ko-fi" || clean === "ko_fi") {
		return "kofi";
	}
	if (clean === "open_collective" || clean === "opencollective") {
		return "opencollective";
	}
	return clean;
}

export function sanitizeSponsorUrl(
	url,
	platform = "kofi",
	login = "",
	{
		defaultKofiUrl = DEFAULT_KOFI_URL,
		allowedHosts = ALLOWED_SPONSOR_HOSTS,
	} = {},
) {
	const fallback =
		platform === PLATFORMS.GITHUB && login
			? `https://github.com/${encodeURIComponent(login)}`
			: defaultKofiUrl;
	const raw = String(url || "").trim();
	if (!raw) return fallback;
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "https:" || !parsed.hostname) {
			return fallback;
		}
		const host = parsed.hostname.toLowerCase();
		const isAllowed =
			allowedHosts instanceof Set
				? allowedHosts.has(host)
				: Array.from(allowedHosts || []).includes(host);
		if (!isAllowed) return fallback;
		return raw;
	} catch {
		return fallback;
	}
}

export function extractGitHubHandle(combined) {
	const ghUrlMatch = String(combined || "").match(
		/(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?=[/?#\s)\].:;!]|$)/i,
	);
	if (
		ghUrlMatch &&
		!["sponsors", "orgs", "settings", "topics"].includes(
			ghUrlMatch[1].toLowerCase(),
		)
	) {
		return ghUrlMatch[1];
	}

	const ghTagMatch = String(combined || "").match(
		/(?:^|[\s(\[])(?:github\s*:\s*@?|gh\s*:\s*@?|@)([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\b/i,
	);
	if (ghTagMatch) {
		const candidate = ghTagMatch[1];
		if (!EMAIL_DOMAINS_IGNORE.has(candidate.toLowerCase())) {
			return candidate;
		}
	}
	return "";
}

