import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	DEFAULT_EXTRA_PATH,
	DEFAULT_FUNDING_PATH,
	getInput,
	kofiProfileUrl,
	loadFundingDefaults,
	loadSponsorsConfig,
	normalizePlatform,
} from "./config.mjs";
import { publishToBranch, readBranchFile, syncBranchRef } from "./git.mjs";
import {
	ingestKofiPayload,
	loadExtraSponsors,
	pruneExtraSponsorsFile,
} from "./kofi.mjs";
import {
	buildDemoSponsors,
	fetchOpenCollectiveSponsors,
	fetchSponsors,
	hasRecurringSponsors,
	mergeSponsors,
	populateAvatars,
	resolveToken,
} from "./providers.mjs";
import { renderPlatformCardSvg, renderSponsorsSvg } from "./svg.mjs";

const USAGE_TEXT = [
	"usage: sponsors [options]",
	"",
	"options:",
	"  --login <user>               GitHub user or organization login override",
	"  --kofi <handle>              Ko-fi handle or URL override",
	"  --opencollective <slug>      OpenCollective collective slug override",
	"  -o, --output <path>          Output SVG path (default: sponsors.svg)",
	"  --config, --extra <path>     Optional JSON config/sponsors file (default: .github/sponsors.json)",
	"  --featured-threshold <usd>   Monthly dollar threshold for Featured sponsors (default: 25)",
	"  --active-window-days <days>  Rolling active window in days for Ko-fi state (default: 35)",
	"  --exclude <logins>           Comma-separated logins to exclude",
	"  --include-past               Include past/inactive GitHub sponsors",
	"  --ingest-kofi <json|@file>   Ko-fi webhook payload JSON or @filepath to ingest",
	"  --branch <name>              Orphan Git branch to update (e.g. badges)",
	"  --push / --no-push           Force-push updated orphan branch to origin",
	"  --dry-run                    Render SVGs and preview state without updating refs or pushing",
	"  --demo                       Render demo sponsors offline without API calls",
	"  -C, --working-directory <d>  Repository root directory",
	"  -h, --help                   Show this help message",
].join("\n");

function readGithubEventPayload() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath || !existsSync(eventPath)) return undefined;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(eventPath, "utf-8"));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(
			`warning: failed to parse GITHUB_EVENT_PATH (${eventPath}): ${msg}\n`,
		);
	}
	return parsed;
}

function resolveDryRun(cliDryRun) {
	if (cliDryRun === true) return true;
	const raw = getInput("dry-run").toLowerCase();
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
		const dispatchVal = readGithubEventPayload()?.inputs?.dry_run;
		if (dispatchVal === true || dispatchVal === "true") return true;
	}
	return false;
}

function isActionInvocation(values) {
	return Boolean(
		values.ci ||
			(process.env.GITHUB_ACTIONS === "true" &&
				(getInput("branch") ||
					getInput("token") ||
					getInput("push-token") ||
					getInput("output"))),
	);
}

export function parseCliArgs(
	argv = process.argv.slice(2),
	{ defaultGh = "", defaultKofi = "", defaultOc = "" } = {},
) {
	const { values } = parseArgs({
		args: argv,
		allowPositionals: false,
		strict: true,
		options: {
			help: { type: "boolean", short: "h" },
			login: { type: "string" },
			kofi: { type: "string" },
			opencollective: { type: "string" },
			output: { type: "string", short: "o" },
			extra: { type: "string" },
			config: { type: "string" },
			"featured-threshold": { type: "string" },
			"active-window-days": { type: "string" },
			exclude: { type: "string" },
			"include-past": { type: "boolean" },
			"ingest-kofi": { type: "string" },
			branch: { type: "string" },
			push: { type: "boolean" },
			"no-push": { type: "boolean" },
			"dry-run": { type: "boolean" },
			demo: { type: "boolean" },
			ci: { type: "boolean" },
			"working-directory": { type: "string", short: "C" },
		},
	});

	const actionMode = isActionInvocation(values);
	const dryRun = resolveDryRun(values["dry-run"]);
	const inputPush = getInput("push").toLowerCase();
	const defaultPush =
		(inputPush ? inputPush === "true" : actionMode) &&
		process.env.GITHUB_EVENT_NAME !== "pull_request";
	const push = dryRun
		? false
		: values["no-push"]
			? false
			: (values.push ?? defaultPush);

	const defaultOutput = actionMode
		? join(process.env.RUNNER_TEMP || tmpdir(), "sponsors", "sponsors.svg")
		: "sponsors.svg";
	const rawExclude = values.exclude ?? getInput("exclude");

	return {
		help: Boolean(values.help),
		login: values.login ?? defaultGh,
		kofi: values.kofi ?? defaultKofi,
		opencollective: values.opencollective ?? defaultOc,
		output: values.output || getInput("output") || defaultOutput,
		extra:
			values.config || values.extra || getInput("config") || DEFAULT_EXTRA_PATH,
		featuredThreshold:
			values["featured-threshold"] !== undefined
				? Number(values["featured-threshold"])
				: null,
		activeWindowDays:
			values["active-window-days"] !== undefined
				? Number(values["active-window-days"])
				: null,
		exclude: rawExclude ? rawExclude.split(",") : null,
		includePast: values["include-past"] ?? null,
		ingestKofi: values["ingest-kofi"] || "",
		branch:
			values.branch ?? ( getInput("branch") || (actionMode ? "badges" : "") ),
		push,
		dryRun,
		demo: Boolean(values.demo),
		ci: Boolean(values.ci),
		workingDirectory:
			values["working-directory"] || getInput("working-directory") || ".",
	};
}

function writeActionOutputs(entries) {
	const outFile = process.env.GITHUB_OUTPUT;
	if (!outFile) return;
	const lines = Object.entries(entries).map(([key, value]) => {
		const strVal = String(value ?? "");
		if (/[\r\n]/.test(key) || /[\r\n]/.test(strVal)) {
			throw new Error(`Invalid newline in GitHub output "${key}"`);
		}
		return `${key}=${strVal}`;
	});
	appendFileSync(outFile, `${lines.join("\n")}\n`, "utf-8");
}

function writeStepSummary({
	sponsors,
	hasMonthly,
	cardPaths,
	branch,
	push,
	dryRun,
}) {
	const summaryPath = process.env.GITHUB_STEP_SUMMARY;
	if (!summaryPath) return;
	const heading = dryRun
		? "### Dry run: Sponsors SVG"
		: "### Sponsors SVG updated";
	const files = ["sponsors.svg", ...cardPaths.map((p) => basename(p))]
		.map((f) => `\`${f}\``)
		.join(", ");
	const targetLine = branch
		? `- **Target branch:** \`${branch}\`${dryRun ? " *(dry-run, not updated)*" : push ? " *(pushed to origin)*" : " *(local ref only)*"}`
		: "- **Target branch:** *(none — local files only)*";
	const md = [
		heading,
		"",
		`- **Public sponsors:** ${sponsors.length}`,
		`- **Recurring active:** ${hasMonthly ? "yes" : "no"}`,
		`- **Generated SVGs:** ${files}`,
		targetLine,
		"",
	].join("\n");
	appendFileSync(summaryPath, md, "utf-8");
}

function prepareBranchOrLocalState({
	args,
	workDir,
	tmpDir,
	extraPath,
	defaultKofiUrl,
	cfg,
}) {
	if (args.branch) {
		const remoteSha = syncBranchRef(args.branch, workDir, {
			fetchRemote: args.push || process.env.GITHUB_ACTIONS === "true",
		});
		const branchStatePath = join(tmpDir, "sponsors.json");
		const existingBranchJson = readBranchFile(
			args.branch,
			"sponsors.json",
			workDir,
		);
		writeFileSync(
			branchStatePath,
			existingBranchJson !== null
				? existingBranchJson
				: '{\n  "sponsors": []\n}\n',
			"utf-8",
		);
		pruneExtraSponsorsFile(branchStatePath, { defaultKofiUrl, config: cfg });
		return { statePath: branchStatePath, remoteSha };
	}

	if (args.dryRun) {
		const dryStatePath = join(tmpDir, "sponsors.json");
		if (existsSync(extraPath)) {
			copyFileSync(extraPath, dryStatePath);
			pruneExtraSponsorsFile(dryStatePath, { defaultKofiUrl, config: cfg });
		}
		return { statePath: dryStatePath, remoteSha: null };
	}

	if (existsSync(extraPath)) {
		pruneExtraSponsorsFile(extraPath, { defaultKofiUrl, config: cfg });
	}
	return { statePath: null, remoteSha: null };
}

function resolveRawKofiPayload(args) {
	const direct = (
		args.ingestKofi ||
		getInput("kofi-payload") ||
		process.env.KOFI_WEBHOOK_PAYLOAD ||
		""
	).trim();
	if (direct && direct !== "null") {
		const text = direct.startsWith("@")
			? readFileSync(direct.slice(1), "utf-8")
			: direct;
		return JSON.parse(text);
	}
	const eventKofi = readGithubEventPayload()?.client_payload?.kofi;
	if (eventKofi && typeof eventKofi === "object") {
		return eventKofi;
	}
	return null;
}

async function maybeIngestKofi(args, ingestTarget, { defaultKofiUrl, cfg }) {
	const kofiPayload = resolveRawKofiPayload(args);
	if (kofiPayload && typeof kofiPayload === "object") {
		await ingestKofiPayload(kofiPayload, ingestTarget, {
			defaultKofiUrl,
			config: cfg,
		});
	}
}

function writePlatformCardSvgs(outDir, platforms, hasMonthly) {
	const cardPlatforms = ["github", "kofi"];
	for (const p of platforms || []) {
		const norm = normalizePlatform(p);
		if (
			["opencollective", "polar", "patreon"].includes(norm) &&
			!cardPlatforms.includes(norm)
		) {
			cardPlatforms.push(norm);
		}
	}
	return cardPlatforms.map((platform) => {
		const cardPath = join(outDir, `sponsor-${platform}.svg`);
		writeFileSync(
			cardPath,
			renderPlatformCardSvg(platform, { hasMonthlySponsors: hasMonthly }),
			"utf-8",
		);
		return cardPath;
	});
}

async function collectAllSponsors({
	args,
	extraPath,
	statePath,
	defaultKofiUrl,
	cfg,
}) {
	const extraPaths =
		args.dryRun && !args.branch
			? [statePath]
			: [extraPath, ...(statePath ? [statePath] : [])];
	const extraSponsors = await loadExtraSponsors(null, null, {
		extraPaths,
		defaultKofiUrl,
		config: cfg,
		fetchAvatars: false,
	});
	const baseSponsors = args.demo
		? buildDemoSponsors()
		: await fetchSponsors(args.login, resolveToken(), {
				featuredThreshold: cfg.featured_threshold,
				includePast: cfg.include_past,
				fetchAvatars: false,
			});
	const ocSponsors =
		!args.demo && args.opencollective
			? await fetchOpenCollectiveSponsors(args.opencollective, {
					featuredThreshold: cfg.featured_threshold,
					fetchAvatars: false,
				})
			: [];
	const merged = mergeSponsors(baseSponsors, ocSponsors, extraSponsors, {
		config: cfg,
	});
	return args.demo
		? merged
		: populateAvatars(merged, {
				featuredThreshold: cfg.featured_threshold,
				tiers: cfg.tiers,
			});
}

function resolveCliContext(argv) {
	const preWorkDir = resolve(
		getInput("working-directory") || process.cwd(),
	);
	const initialFunding = loadFundingDefaults(
		join(preWorkDir, DEFAULT_FUNDING_PATH),
		preWorkDir,
	);
	const parsed = parseCliArgs(argv, {
		defaultGh: initialFunding.github,
		defaultKofi: initialFunding.kofi,
		defaultOc: initialFunding.open_collective,
	});
	if (parsed.help) return { help: true };

	const workDir = resolve(parsed.workingDirectory);
	const fundingDefaults =
		workDir === preWorkDir
			? initialFunding
			: loadFundingDefaults(join(workDir, DEFAULT_FUNDING_PATH), workDir);
	const args =
		workDir === preWorkDir
			? parsed
			: parseCliArgs(argv, {
					defaultGh: fundingDefaults.github,
					defaultKofi: fundingDefaults.kofi,
					defaultOc: fundingDefaults.open_collective,
				});

	const defaultKofiUrl = kofiProfileUrl(args.kofi);
	const extraPath = resolve(workDir, args.extra);
	const cfg = loadSponsorsConfig(extraPath, {
		featuredThreshold: args.featuredThreshold,
		activeWindowDays: args.activeWindowDays,
		exclude: args.exclude,
		includePast: args.includePast,
	});
	const outPath = resolve(workDir, args.output);
	const outDir = dirname(outPath);
	mkdirSync(outDir, { recursive: true });
	return {
		help: false,
		workDir,
		fundingDefaults,
		args,
		defaultKofiUrl,
		extraPath,
		cfg,
		outPath,
		outDir,
	};
}

export async function main(argv = process.argv.slice(2)) {
	const ctx = resolveCliContext(argv);
	if (ctx.help) {
		process.stdout.write(`${USAGE_TEXT}\n`);
		return 0;
	}
	const {
		workDir,
		fundingDefaults,
		args,
		defaultKofiUrl,
		extraPath,
		cfg,
		outPath,
		outDir,
	} = ctx;

	const tmpDir = mkdtempSync(join(tmpdir(), "sponsors-"));
	try {
		const { statePath, remoteSha } = prepareBranchOrLocalState({
			args,
			workDir,
			tmpDir,
			extraPath,
			defaultKofiUrl,
			cfg,
		});
		await maybeIngestKofi(args, statePath || extraPath, {
			defaultKofiUrl,
			cfg,
		});
		const sponsors = await collectAllSponsors({
			args,
			extraPath,
			statePath,
			defaultKofiUrl,
			cfg,
		});
		const hasMonthly = hasRecurringSponsors(sponsors);
		writeFileSync(
			outPath,
			renderSponsorsSvg(sponsors, {
				featuredThreshold: cfg.featured_threshold,
				tiers: cfg.tiers,
			}),
			"utf-8",
		);
		const cardPaths = writePlatformCardSvgs(
			outDir,
			fundingDefaults.platforms,
			hasMonthly,
		);
		process.stdout.write(
			`Wrote ${outPath}, ${cardPaths.join(", ")} (${sponsors.length} public sponsor(s), recurring=${hasMonthly}${args.dryRun ? ", dry-run=true" : ""})\n`,
		);
		if (args.branch && statePath && !args.dryRun) {
			publishToBranch(
				[outPath, ...cardPaths, statePath],
				args.branch,
				args.push,
				workDir,
				{ alreadySynced: true, remoteSha },
			);
		}
		writeActionOutputs({
			sponsors_count: sponsors.length,
			has_recurring: hasMonthly,
			dry_run: args.dryRun,
			svg_path: outPath,
			cards: cardPaths.join(","),
		});
		writeStepSummary({
			sponsors,
			hasMonthly,
			cardPaths,
			branch: args.branch,
			push: args.push,
			dryRun: args.dryRun,
		});
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
	return 0;
}
