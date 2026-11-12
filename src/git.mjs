import { spawnSync } from "node:child_process";
import { getInput } from "./config.mjs";

const GENERATED_CARD_FILE_RE =
	/^sponsor-(?:github|kofi|opencollective|polar|patreon)\.svg$/i;

export function resolveGitTokens(explicitPushToken, explicitApiToken) {
	const primaryCandidates = [
		explicitPushToken,
		getInput("push-token"),
		process.env.GITHUB_TOKEN,
		process.env.GITHUB_ACTION_TOKEN,
		explicitApiToken,
		getInput("token"),
		process.env.SPONSORS_TOKEN,
		process.env.GH_TOKEN,
	];
	const primary =
		primaryCandidates.map((t) => (t || "").trim()).find(Boolean) || "";
	const fallbackCandidates = [
		explicitApiToken,
		getInput("token"),
		process.env.SPONSORS_TOKEN,
		explicitPushToken,
		getInput("push-token"),
		process.env.GITHUB_TOKEN,
	];
	const fallback =
		fallbackCandidates
			.map((t) => (t || "").trim())
			.find((t) => t && t !== primary) || "";
	return { primary, fallback };
}

export function buildGitEnv({ auth = false, token, extraEnv } = {}) {
	const env = {
		...process.env,
		...extraEnv,
		GIT_TERMINAL_PROMPT: "0",
	};
	const resolvedToken = (token || "").trim();
	if (!auth || !resolvedToken) return env;

	const serverUrl = (
		process.env.GITHUB_SERVER_URL || "https://github.com"
	).replace(/\/+$/, "");
	const basic = Buffer.from(`x-access-token:${resolvedToken}`, "utf8").toString(
		"base64",
	);
	const baseCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
	const offset = Number.isFinite(baseCount) && baseCount > 0 ? baseCount : 0;
	env.GIT_CONFIG_COUNT = String(offset + 2);
	env[`GIT_CONFIG_KEY_${offset}`] = `http.${serverUrl}/.extraheader`;
	env[`GIT_CONFIG_VALUE_${offset}`] = "";
	env[`GIT_CONFIG_KEY_${offset + 1}`] = `http.${serverUrl}/.extraheader`;
	env[`GIT_CONFIG_VALUE_${offset + 1}`] = `AUTHORIZATION: basic ${basic}`;
	return env;
}

export function runGit(
	args,
	repoDir,
	{
		check = true,
		inputText = undefined,
		env = undefined,
		auth = false,
		token = undefined,
		fallbackToken = undefined,
	} = {},
) {
	const execOnce = (tok) =>
		spawnSync("git", args, {
			cwd: repoDir,
			timeout: 60000,
			maxBuffer: 16 * 1024 * 1024,
			input: inputText,
			env: buildGitEnv({ auth, token: tok, extraEnv: env }),
			encoding: "utf-8",
		});

	let res = execOnce(token);
	if (
		!res.error &&
		res.status !== 0 &&
		auth &&
		fallbackToken &&
		fallbackToken !== token
	) {
		res = execOnce(fallbackToken);
	}

	if (res.error) {
		if (check) throw res.error;
		return { returncode: 1, stdout: "", stderr: String(res.error) };
	}

	const returncode = res.status ?? 1;
	const stdout = res.stdout ? String(res.stdout) : "";
	const stderr = res.stderr ? String(res.stderr) : "";
	if (check && returncode !== 0) {
		const detail = stderr.trim() || stdout.trim();
		throw new Error(
			`Command failed: git ${args.join(" ")}${detail ? `\n${detail}` : ""}`,
		);
	}
	return { returncode, stdout, stderr };
}

export function gitIdentityEnv(repoDir) {
	const env = { ...process.env };
	for (const role of ["AUTHOR", "COMMITTER"]) {
		const res = runGit(["var", `GIT_${role}_IDENT`], repoDir, { check: false });
		if (res.returncode !== 0) {
			env[`GIT_${role}_NAME`] ||= "github-actions[bot]";
			env[`GIT_${role}_EMAIL`] ||=
				"41898282+github-actions[bot]@users.noreply.github.com";
		}
	}
	return env;
}

export function syncBranchRef(
	branch,
	repoDir,
	{ fetchRemote = false, pushToken = undefined, apiToken = undefined } = {},
) {
	const ref = `refs/heads/${branch}`;
	const { primary, fallback } = resolveGitTokens(pushToken, apiToken);
	const localExists =
		runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoDir, {
			check: false,
		}).returncode === 0;

	if (fetchRemote || !localExists) {
		const lsRes = runGit(
			["ls-remote", "--exit-code", "--heads", "origin", branch],
			repoDir,
			{
				check: false,
				auth: true,
				token: primary,
				fallbackToken: fallback,
			},
		);
		if (lsRes.returncode === 0) {
			const remoteSha = lsRes.stdout.trim().split(/\s+/)[0] || null;
			runGit(["fetch", "--no-tags", "origin", `+${ref}:${ref}`], repoDir, {
				auth: true,
				token: primary,
				fallbackToken: fallback,
			});
			return remoteSha;
		}
	}
	return null;
}

export function readBranchFile(branch, filename, repoDir) {
	const res = runGit(["show", `refs/heads/${branch}:${filename}`], repoDir, {
		check: false,
	});
	return res.returncode === 0 ? res.stdout : null;
}

function buildBranchTree(svgPaths, ref, repoDir) {
	const updatedNames = new Set();
	const entryLines = [];
	for (const svgPath of svgPaths) {
		const name = svgPath.split(/[\\/]/).pop();
		const blobSha = runGit(
			["hash-object", "-w", svgPath],
			repoDir,
		).stdout.trim();
		entryLines.push(`100644 blob ${blobSha}\t${name}`);
		updatedNames.add(name);
	}

	const existingTree = runGit(["ls-tree", ref], repoDir, { check: false });
	if (existingTree.returncode === 0) {
		for (const line of existingTree.stdout.split(/\r?\n/)) {
			const tabIdx = line.indexOf("\t");
			const name = tabIdx !== -1 ? line.slice(tabIdx + 1) : "";
			if (
				name &&
				!updatedNames.has(name) &&
				!GENERATED_CARD_FILE_RE.test(name)
			) {
				entryLines.push(line);
			}
		}
	}

	return runGit(["mktree"], repoDir, {
		inputText: `${entryLines.join("\n")}\n`,
	}).stdout.trim();
}

function pushRefWithRetry(
	ref,
	branch,
	svgPaths,
	repoDir,
	remoteSha,
	{ primary, fallback },
) {
	const leaseArg =
		remoteSha !== null
			? `--force-with-lease=${ref}:${remoteSha}`
			: "--force";
	const firstPush = runGit(
		["push", leaseArg, "origin", `${ref}:${ref}`],
		repoDir,
		{
			check: false,
			auth: true,
			token: primary,
			fallbackToken: fallback,
		},
	);
	if (firstPush.returncode === 0) return;

	if (remoteSha !== null && /stale info|rejected/i.test(firstPush.stderr)) {
		syncBranchRef(branch, repoDir, {
			fetchRemote: true,
			pushToken: primary,
			apiToken: fallback,
		});
		const mergedTree = buildBranchTree(svgPaths, ref, repoDir);
		const namesLabel = svgPaths.map((p) => p.split(/[\\/]/).pop()).join(", ");
		const rebuiltSha = runGit(
			["commit-tree", mergedTree, "-m", `chore: update ${namesLabel}`],
			repoDir,
			{ env: gitIdentityEnv(repoDir) },
		).stdout.trim();
		runGit(["update-ref", ref, rebuiltSha], repoDir);
		runGit(["push", "--force", "origin", `${ref}:${ref}`], repoDir, {
			auth: true,
			token: primary,
			fallbackToken: fallback,
		});
		return;
	}

	const detail = firstPush.stderr.trim() || firstPush.stdout.trim();
	throw new Error(
		`Command failed: git push ${leaseArg} origin ${ref}:${ref}${detail ? `\n${detail}` : ""}`,
	);
}

export function publishToBranch(
	svgPaths,
	branch,
	push,
	repoDir,
	{
		alreadySynced = false,
		remoteSha = undefined,
		pushToken = undefined,
		apiToken = undefined,
	} = {},
) {
	const ref = `refs/heads/${branch}`;
	const { primary, fallback } = resolveGitTokens(pushToken, apiToken);
	const resolvedRemoteSha = alreadySynced
		? (remoteSha ?? null)
		: syncBranchRef(branch, repoDir, {
				fetchRemote: push,
				pushToken: primary,
				apiToken: fallback,
			});

	const treeSha = buildBranchTree(svgPaths, ref, repoDir);
	const tipRes = runGit(
		["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
		repoDir,
		{ check: false },
	);
	const tip = tipRes.returncode === 0 ? tipRes.stdout.trim() : null;
	if (tip) {
		const tipTree = runGit(["rev-parse", `${tip}^{tree}`], repoDir).stdout.trim();
		const hasParent =
			runGit(["rev-parse", "--verify", "--quiet", `${tip}^`], repoDir, {
				check: false,
			}).returncode === 0;
		if (tipTree === treeSha && !hasParent) {
			process.stdout.write(
				`Branch '${branch}' is already up to date (${tip.slice(0, 7)})\n`,
			);
			if (push && resolvedRemoteSha !== tip) {
				pushRefWithRetry(ref, branch, svgPaths, repoDir, resolvedRemoteSha, {
					primary,
					fallback,
				});
				process.stdout.write(`Pushed '${branch}' to origin\n`);
			}
			return;
		}
	}

	const namesLabel = svgPaths
		.map((p) => p.split(/[\\/]/).pop())
		.join(", ");
	const commitSha = runGit(
		["commit-tree", treeSha, "-m", `chore: update ${namesLabel}`],
		repoDir,
		{ env: gitIdentityEnv(repoDir) },
	).stdout.trim();

	runGit(["update-ref", ref, commitSha], repoDir);
	process.stdout.write(
		`Updated branch '${branch}' (${commitSha.slice(0, 7)}) with ${namesLabel}\n`,
	);

	if (push) {
		pushRefWithRetry(ref, branch, svgPaths, repoDir, resolvedRemoteSha, {
			primary,
			fallback,
		});
		process.stdout.write(`Pushed '${branch}' to origin\n`);
	}
}
