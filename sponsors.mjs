#!/usr/bin/env node
/**
 * Zero-dependency node24 GitHub Action and CLI for generating light/dark-aware
 * Sponsors walls and platform CTA SVGs onto an orphan branch.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { main } from "./src/cli.mjs";

export { main, parseCliArgs } from "./src/cli.mjs";
export {
	ACTIVE_WINDOW_DAYS,
	ALLOWED_SPONSOR_HOSTS,
	ANONYMOUS_NAMES,
	CURRENCY_TO_USD,
	DEFAULT_EXTRA_PATH,
	DEFAULT_FUNDING_PATH,
	DEFAULT_KOFI_URL,
	EMAIL_DOMAINS_IGNORE,
	expandAllowedHosts,
	extractGitHubHandle,
	FEATURED_THRESHOLD,
	GRAPHQL_URL,
	getInput,
	isExpired,
	KOFI_TEST_EMAIL,
	KOFI_TEST_EMAIL_SHA256,
	KOFI_TEST_TRANSACTION_ID,
	KOFI_TIER_PRICES,
	kofiProfileUrl,
	loadFundingDefaults,
	loadSponsorsConfig,
	normalizePlatform,
	OPENCOLLECTIVE_GRAPHQL_URL,
	PLATFORMS,
	parseFundingFile,
	parseIsoDatetime,
	Sponsor,
	SponsorsConfig,
	sanitizeSponsorUrl,
	TIER_PRESETS,
	USER_AGENT,
} from "./src/config.mjs";
export {
	buildGitEnv,
	gitIdentityEnv,
	publishToBranch,
	readBranchFile,
	resolveGitTokens,
	syncBranchRef,
} from "./src/git.mjs";
export {
	cleanDisplayName,
	collectActiveRecords,
	extractRobloxTag,
	extractSponsorIdentity,
	ingestKofiPayload,
	isAnonymousName,
	loadExtraSponsors,
	parseExtraEntries,
	probeGravatarUrl,
	pruneExtraSponsorsFile,
	resolveKofiTierDollars,
	resolveRobloxProfile,
} from "./src/kofi.mjs";
export {
	buildDemoSponsors,
	buildGraphqlQuery,
	canonicalSponsorKey,
	fetchAvatarDataUri,
	fetchOpenCollectiveSponsors,
	fetchSponsors,
	GRAPHQL_QUERY,
	GRAPHQL_USER_ONLY_QUERY,
	hasRecurringSponsors,
	mergeSponsors,
	nodeToSponsor,
	OPENCOLLECTIVE_QUERY,
	populateAvatars,
	postGraphql,
	resolveToken,
} from "./src/providers.mjs";
export {
	escapeXml,
	renderEmptySvg,
	renderPlatformCardSvg,
	renderSponsorsSvg,
	renderStyle,
	renderTierSection,
	resolveTierGroups,
	SVG_STYLE,
	sortSponsors,
	truncateLabel,
} from "./src/svg.mjs";

function isExecutedDirectly() {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return import.meta.url === pathToFileURL(realpathSync(entry)).href;
	} catch {
		return import.meta.url === pathToFileURL(entry).href;
	}
}

if (isExecutedDirectly()) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			process.stderr.write(`${err?.stack || err}\n`);
			process.exit(1);
		},
	);
}
