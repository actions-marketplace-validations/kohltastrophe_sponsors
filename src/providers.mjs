import { execFileSync } from "node:child_process";
import {
	extractGitHubHandle,
	FEATURED_THRESHOLD,
	GRAPHQL_URL,
	getInput,
	OPENCOLLECTIVE_GRAPHQL_URL,
	PLATFORMS,
	Sponsor,
	USER_AGENT,
} from "./config.mjs";
import { resolveTierGroups, sortSponsors } from "./svg.mjs";

export function buildGraphqlQuery({
	includeOrg = true,
	activeOnly = true,
} = {}) {
	const orgFragment = includeOrg
		? `
          ... on Organization {
            login
            name
            avatarUrl(size: 160)
            url
          }`
		: "";
	const activeArg = activeOnly ? "" : ", activeOnly: false";
	return `
query($login: String!, $cursor: String) {
  repositoryOwner(login: $login) {
    ... on Sponsorable {
      sponsorshipsAsMaintainer(first: 100, after: $cursor, includePrivate: false${activeArg}) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isActive
          tier {
            name
            monthlyPriceInDollars
            isOneTime
          }
          sponsorEntity {
            ... on User {
              login
              name
              avatarUrl(size: 160)
              url
            }${orgFragment}
          }
        }
      }
    }
  }
}
`;
}

export const GRAPHQL_QUERY = buildGraphqlQuery({
	includeOrg: true,
	activeOnly: true,
});
export const GRAPHQL_USER_ONLY_QUERY = buildGraphqlQuery({
	includeOrg: false,
	activeOnly: true,
});

export const OPENCOLLECTIVE_QUERY = `
query($slug: String!, $limit: Int!, $offset: Int!) {
  collective(slug: $slug) {
    members(role: BACKER, limit: $limit, offset: $offset) {
      nodes {
        tier {
          name
          frequency
          amount {
            valueInCents
          }
        }
        totalDonations {
          valueInCents
        }
        account {
          slug
          name
          imageUrl(height: 160)
          website
          socialLinks {
            type
            url
          }
        }
      }
    }
  }
}
`;

export function resolveToken() {
	const candidates = [
		getInput("token"),
		process.env.SPONSORS_TOKEN,
		getInput("push-token"),
		process.env.GITHUB_TOKEN,
		process.env.GH_TOKEN,
		process.env.GITHUB_ACTION_TOKEN,
	];
	for (const raw of candidates) {
		const token = (raw || "").trim();
		if (token) return token;
	}
	try {
		return execFileSync("gh", ["auth", "token"], {
			timeout: 15000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "";
	}
}

export async function fetchAvatarDataUri(
	url,
	size = 128,
	{ fetchImpl = globalThis.fetch } = {},
) {
	if (!url || typeof fetchImpl !== "function") return "";
	try {
		const parsed = new URL(url);
		if (
			parsed.hostname.endsWith("githubusercontent.com") ||
			parsed.hostname === "github.com"
		) {
			const param = parsed.hostname.endsWith("githubusercontent.com")
				? "s"
				: "size";
			parsed.searchParams.set(param, String(size));
		}
		const resp = await fetchImpl(parsed.toString(), {
			headers: { "User-Agent": USER_AGENT },
			signal: AbortSignal.timeout(15000),
		});
		if (!resp.ok) {
			throw new Error(`HTTP ${resp.status}`);
		}
		let contentType = (resp.headers.get("content-type") || "image/png")
			.split(";")[0]
			.trim();
		if (!contentType.startsWith("image/")) {
			contentType = "image/png";
		}
		const buf = Buffer.from(await resp.arrayBuffer());
		return `data:${contentType};base64,${buf.toString("base64")}`;
	} catch (err) {
		process.stderr.write(`warning: failed to fetch avatar ${url}: ${err}\n`);
		return "";
	}
}

export function hasRecurringSponsors(sponsors) {
	return sponsors.some(
		(s) =>
			!s.is_past &&
			((!s.is_one_time && s.monthly_dollars > 0) || s.tier_unknown),
	);
}

function resolveTargetAvatarPixels(renderedAvatarSize) {
	if (renderedAvatarSize > 64) return 160;
	if (renderedAvatarSize >= 54) return 128;
	return 96;
}

function buildAvatarSizeMap(sponsors, { featuredThreshold, tiers }) {
	const sizes = new Map();
	for (const g of resolveTierGroups(sponsors, { featuredThreshold, tiers })) {
		const targetPx = resolveTargetAvatarPixels(g.preset.avatar_size);
		for (const item of g.items) {
			sizes.set(item, targetPx);
		}
	}
	return sizes;
}

export async function populateAvatars(
	sponsors,
	{
		featuredThreshold = FEATURED_THRESHOLD,
		tiers = null,
		fetchImpl = globalThis.fetch,
		concurrency = 8,
	} = {},
) {
	const results = [...sponsors];
	const sizeBySponsor = buildAvatarSizeMap(results, {
		featuredThreshold,
		tiers,
	});
	const queue = [];
	for (let i = 0; i < results.length; i++) {
		const s = results[i];
		if (!s.avatar_data_uri && s.avatar_url) {
			const fallbackSize =
				!s.is_one_time && !s.is_past && s.monthly_dollars >= featuredThreshold
					? 128
					: 96;
			queue.push({
				idx: i,
				sponsor: s,
				size: sizeBySponsor.get(s) ?? fallbackSize,
			});
		}
	}
	if (queue.length === 0) return results;

	const inFlight = new Map();
	let cursor = 0;
	async function worker() {
		while (cursor < queue.length) {
			const item = queue[cursor++];
			const cacheKey = `${item.sponsor.avatar_url}#${item.size}`;
			let promise = inFlight.get(cacheKey);
			if (!promise) {
				promise = fetchAvatarDataUri(item.sponsor.avatar_url, item.size, {
					fetchImpl,
				});
				inFlight.set(cacheKey, promise);
			}
			const uri = await promise;
			if (uri) {
				results[item.idx] = new Sponsor({
					...item.sponsor,
					avatar_data_uri: uri,
				});
			}
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()),
	);
	return results;
}

function isInsufficientScopes(errors) {
	if (!Array.isArray(errors)) return false;
	return errors.some(
		(err) =>
			err && typeof err === "object" && err.type === "INSUFFICIENT_SCOPES",
	);
}

export async function postGraphql(
	query,
	variables,
	token,
	{ fetchImpl = globalThis.fetch, url = GRAPHQL_URL } = {},
) {
	const headers = {
		"Content-Type": "application/json",
		"User-Agent": USER_AGENT,
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	const resp = await fetchImpl(url, {
		method: "POST",
		headers,
		body: JSON.stringify({ query, variables }),
		signal: AbortSignal.timeout(20000),
	});
	const body = await resp.json();
	return body && typeof body === "object" ? body : {};
}

export async function nodeToSponsor(
	node,
	{
		featuredThreshold = FEATURED_THRESHOLD,
		fetchAvatars = false,
		fetchImpl = globalThis.fetch,
	} = {},
) {
	if (!node || typeof node !== "object") return null;
	const entity = node.sponsorEntity;
	if (!entity || typeof entity !== "object") return null;
	const sponsorLogin = String(entity.login || "").trim();
	if (!sponsorLogin) return null;

	const isPast = node.isActive === false;
	const rawTier = node.tier;
	let monthly = 0;
	let isOneTime = false;
	let tierUnknown = false;

	if (!rawTier || typeof rawTier !== "object") {
		process.stderr.write(
			`warning: GitHub GraphQL returned tier=null for @${sponsorLogin}; configure SPONSORS_TOKEN with read:user scope to read tier pricing\n`,
		);
		monthly = 0;
		isOneTime = true;
		tierUnknown = !isPast;
	} else {
		monthly = Math.trunc(Number(rawTier.monthlyPriceInDollars || 0));
		isOneTime = Boolean(rawTier.isOneTime || false);
	}

	const avatarUrl = String(entity.avatarUrl || "").trim();
	const avatarSize =
		!isOneTime && !isPast && monthly >= featuredThreshold ? 128 : 96;
	const avatarDataUri =
		fetchAvatars && avatarUrl
			? await fetchAvatarDataUri(avatarUrl, avatarSize, { fetchImpl })
			: "";

	return new Sponsor({
		login: sponsorLogin,
		name: String(entity.name || sponsorLogin).trim(),
		avatar_url: avatarUrl,
		url: String(entity.url || `https://github.com/${sponsorLogin}`),
		monthly_dollars: isPast ? -1 : monthly,
		is_one_time: isOneTime,
		avatar_data_uri: avatarDataUri,
		platform: "github",
		tier_unknown: tierUnknown,
		is_past: isPast,
	});
}

export async function fetchSponsors(
	login,
	token,
	{
		featuredThreshold = FEATURED_THRESHOLD,
		includePast = false,
		fetchAvatars = false,
		postGraphqlImpl = postGraphql,
		fetchImpl = globalThis.fetch,
	} = {},
) {
	const cleanLogin = String(login || "").trim();
	if (!cleanLogin) {
		throw new Error(
			"No GitHub username configured. Set `github:` in .github/FUNDING.yml, pass `--login`, or set GITHUB_LOGIN.",
		);
	}
	if (!token) {
		throw new Error(
			"No GitHub token found. Set SPONSORS_TOKEN / GITHUB_TOKEN or sign in with `gh auth login`.",
		);
	}

	const sponsors = [];
	let cursor = null;
	let includeOrg = true;
	let query = buildGraphqlQuery({
		includeOrg: true,
		activeOnly: !includePast,
	});

	while (true) {
		const variables = { login: cleanLogin, cursor };
		let body = await postGraphqlImpl(query, variables, token, { fetchImpl });
		if (body.errors && includeOrg && isInsufficientScopes(body.errors)) {
			includeOrg = false;
			query = buildGraphqlQuery({
				includeOrg: false,
				activeOnly: !includePast,
			});
			body = await postGraphqlImpl(query, variables, token, { fetchImpl });
		}

		if (body.errors) {
			throw new Error(`GitHub GraphQL error: ${JSON.stringify(body.errors)}`);
		}

		const data = body.data;
		const ownerData =
			data && typeof data === "object"
				? data.repositoryOwner || data.user || data.organization
				: null;
		if (!ownerData || typeof ownerData !== "object") {
			throw new Error(`GitHub user or organization '${cleanLogin}' not found.`);
		}

		const conn = ownerData.sponsorshipsAsMaintainer;
		if (!conn || typeof conn !== "object") break;

		for (const node of conn.nodes || []) {
			if (!includePast && node?.isActive === false) continue;
			const sponsor = await nodeToSponsor(node, {
				featuredThreshold,
				fetchAvatars: false,
				fetchImpl,
			});
			if (sponsor) sponsors.push(sponsor);
		}

		const pageInfo = conn.pageInfo;
		if (!pageInfo || !pageInfo.hasNextPage) break;
		cursor = pageInfo.endCursor ? String(pageInfo.endCursor) : null;
	}

	const sorted = sortSponsors(sponsors);
	return fetchAvatars
		? populateAvatars(sorted, { featuredThreshold, fetchImpl })
		: sorted;
}

function resolveOpenCollectiveDollars(node) {
	const freq = String(node?.tier?.frequency || "").toUpperCase();
	const isOneTime = freq !== "MONTHLY" && freq !== "YEARLY";
	const tierCents = Number(node?.tier?.amount?.valueInCents || 0);
	const totalCents = Number(node?.totalDonations?.valueInCents || 0);

	if (!isOneTime && tierCents > 0) {
		const monthly =
			freq === "YEARLY" ? tierCents / 100 / 12 : tierCents / 100;
		return { isOneTime, dollars: Math.max(1, Math.round(monthly)) };
	}

	const fallbackCents =
		!isOneTime && freq === "YEARLY" ? totalCents / 12 : totalCents;
	return { isOneTime, dollars: Math.round(fallbackCents / 100) };
}

export async function fetchOpenCollectiveSponsors(
	slug,
	{
		featuredThreshold = FEATURED_THRESHOLD,
		fetchAvatars = false,
		postGraphqlImpl = postGraphql,
		fetchImpl = globalThis.fetch,
	} = {},
) {
	const cleanSlug = String(slug || "").trim();
	if (!cleanSlug) return [];

	const body = await postGraphqlImpl(
		OPENCOLLECTIVE_QUERY,
		{ slug: cleanSlug, limit: 100, offset: 0 },
		"",
		{ fetchImpl, url: OPENCOLLECTIVE_GRAPHQL_URL },
	);

	const nodes = body?.data?.collective?.members?.nodes;
	if (!Array.isArray(nodes)) return [];

	const sponsors = [];
	for (const node of nodes) {
		const account = node?.account;
		if (!account?.slug) continue;
		const { isOneTime, dollars } = resolveOpenCollectiveDollars(node);
		if (dollars < 1) continue;

		const ghSocial = Array.isArray(account.socialLinks)
			? account.socialLinks.find((s) =>
					String(s?.url || "").includes("github.com/"),
				)
			: null;
		const ghHandle = ghSocial ? extractGitHubHandle(ghSocial.url) : "";
		const login = ghHandle || String(account.slug).trim();
		const url = ghHandle
			? `https://github.com/${ghHandle}`
			: `https://opencollective.com/${account.slug}`;
		const avatarUrl = String(account.imageUrl || "").trim();

		sponsors.push(
			new Sponsor({
				login,
				name: String(account.name || login).trim(),
				avatar_url: avatarUrl,
				url,
				monthly_dollars: dollars,
				is_one_time: isOneTime,
				platform: "opencollective",
			}),
		);
	}
	const sorted = sortSponsors(sponsors);
	return fetchAvatars
		? populateAvatars(sorted, { featuredThreshold, fetchImpl })
		: sorted;
}

export function canonicalSponsorKey(sponsor) {
	try {
		const parsed = new URL(sponsor.url);
		const host = (parsed.hostname || "").toLowerCase();
		const pathParts = parsed.pathname.split("/").filter(Boolean);
		if (
			(host === "github.com" || host === "www.github.com") &&
			pathParts.length > 0
		) {
			return `github:${pathParts[0].toLowerCase()}`;
		}
		if (
			(host === "roblox.com" || host === "www.roblox.com") &&
			pathParts.length >= 2 &&
			pathParts[0].toLowerCase() === "users"
		) {
			return `roblox:${pathParts[1].toLowerCase()}`;
		}
	} catch {
		// Fall through to login key
	}
	return `login:${sponsor.login.toLowerCase()}`;
}

function combineSponsorPair(existing, incoming) {
	const crossPlatform =
		existing.platform.toLowerCase() !== incoming.platform.toLowerCase();
	let isOneTime = false;
	let monthlyDollars = 0;

	if (!existing.is_one_time && !incoming.is_one_time) {
		isOneTime = false;
		monthlyDollars = crossPlatform
			? existing.monthly_dollars + incoming.monthly_dollars
			: Math.max(existing.monthly_dollars, incoming.monthly_dollars);
	} else if (!existing.is_one_time) {
		isOneTime = false;
		monthlyDollars = existing.monthly_dollars;
	} else if (!incoming.is_one_time) {
		isOneTime = false;
		monthlyDollars = incoming.monthly_dollars;
	} else {
		isOneTime = true;
		monthlyDollars = crossPlatform
			? existing.monthly_dollars + incoming.monthly_dollars
			: Math.max(existing.monthly_dollars, incoming.monthly_dollars);
	}

	const primary =
		existing.platform === PLATFORMS.GITHUB ||
		(incoming.platform !== PLATFORMS.GITHUB && !existing.is_one_time)
			? existing
			: incoming;
	const secondary = primary === existing ? incoming : existing;

	const name =
		primary.name.toLowerCase() !== primary.login.toLowerCase() ||
		secondary.name.toLowerCase() === secondary.login.toLowerCase()
			? primary.name
			: secondary.name;

	let primaryIsGenericKofi = false;
	try {
		const host = new URL(primary.url).hostname.toLowerCase();
		primaryIsGenericKofi = host === "ko-fi.com" || host === "www.ko-fi.com";
	} catch {
		// Ignore URL parse error
	}
	const url =
		primaryIsGenericKofi && secondary.url ? secondary.url : primary.url;
	const avatarUrl = primary.avatar_url || secondary.avatar_url;
	const avatarDataUri = primary.avatar_data_uri || secondary.avatar_data_uri;
	const tierUnknown =
		isOneTime &&
		monthlyDollars === 0 &&
		(existing.tier_unknown || incoming.tier_unknown);
	const isPast = existing.is_past && incoming.is_past;

	return new Sponsor({
		login: primary.login,
		name,
		avatar_url: avatarUrl,
		url,
		monthly_dollars: monthlyDollars,
		is_one_time: isOneTime,
		avatar_data_uri: avatarDataUri,
		platform: primary.platform,
		tier_unknown: tierUnknown,
		is_past: isPast,
	});
}

function applySponsorOverridesAndExclusions(sponsor, config) {
	if (!config) return sponsor;
	const loginLower = sponsor.login.toLowerCase();
	const nameLower = sponsor.name.toLowerCase();
	if (config.exclude?.has(loginLower) || config.exclude?.has(nameLower)) {
		return null;
	}
	const override = config.overrides?.[loginLower];
	if (!override || typeof override !== "object") {
		return sponsor;
	}
	return new Sponsor({
		...sponsor,
		name: override.name != null ? String(override.name) : sponsor.name,
		url: override.url != null ? String(override.url) : sponsor.url,
		avatar_url:
			override.avatar_url != null
				? String(override.avatar_url)
				: sponsor.avatar_url,
		monthly_dollars:
			override.monthly_dollars != null
				? Number(override.monthly_dollars)
				: sponsor.monthly_dollars,
		is_one_time:
			override.is_one_time != null
				? Boolean(override.is_one_time)
				: sponsor.is_one_time,
	});
}

export function mergeSponsors(...args) {
	let options = {};
	let groups = args;
	if (
		args.length > 0 &&
		args[args.length - 1] &&
		!Array.isArray(args[args.length - 1]) &&
		typeof args[args.length - 1] === "object"
	) {
		options = args[args.length - 1];
		groups = args.slice(0, -1);
	}
	const config = options.config || null;
	const merged = new Map();

	for (const group of groups) {
		for (const rawSponsor of group || []) {
			const sponsor = applySponsorOverridesAndExclusions(rawSponsor, config);
			if (!sponsor) continue;
			const key = canonicalSponsorKey(sponsor);
			const existing = merged.get(key);
			merged.set(
				key,
				existing ? combineSponsorPair(existing, sponsor) : sponsor,
			);
		}
	}
	return sortSponsors(Array.from(merged.values()));
}

export function buildDemoSponsors() {
	return [
		new Sponsor({
			login: "ada",
			name: "Ada Lovelace",
			avatar_url: "",
			url: "https://github.com/ada",
			monthly_dollars: 25,
			is_one_time: false,
			platform: "github",
		}),
		new Sponsor({
			login: "grace",
			name: "Grace Hopper",
			avatar_url: "",
			url: "https://ko-fi.com/grace",
			monthly_dollars: 25,
			is_one_time: false,
			platform: "kofi",
		}),
		new Sponsor({
			login: "linus",
			name: "Linus Torvalds",
			avatar_url: "",
			url: "https://github.com/linus",
			monthly_dollars: 5,
			is_one_time: false,
			platform: "github",
		}),
		new Sponsor({
			login: "margaret",
			name: "Margaret Hamilton",
			avatar_url: "",
			url: "https://ko-fi.com/margaret",
			monthly_dollars: 5,
			is_one_time: false,
			platform: "kofi",
		}),
		new Sponsor({
			login: "ken",
			name: "Ken Thompson",
			avatar_url: "",
			url: "https://ko-fi.com/ken",
			monthly_dollars: 1,
			is_one_time: true,
			platform: "kofi",
		}),
	];
}
