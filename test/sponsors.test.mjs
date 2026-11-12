import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import * as sponsors from "../sponsors.mjs";
import worker, { hmacSha256Hex } from "../worker.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPONSORS_MJS = join(REPO_ROOT, "sponsors.mjs");

describe("sponsors", () => {
	const fixedNow = new Date("2026-11-05T12:00:00Z");
	let savedEnv;
	let tempDirs = [];

	function makeTempDir() {
		const dir = mkdtempSync(join(tmpdir(), "sponsors-test-"));
		tempDirs.push(dir);
		return dir;
	}

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.GITHUB_LOGIN = "";
		process.env.KOFI_HANDLE = "";
		process.env.OPENCOLLECTIVE_SLUG = "";
		process.env.INPUT_LOGIN = "";
		process.env.INPUT_KOFI = "";
		process.env.INPUT_OPENCOLLECTIVE = "";
		process.env.GITHUB_REPOSITORY_OWNER = "";
		process.env.GITHUB_REPOSITORY = "";
		process.env.EXTRA_SPONSORS_JSON = "";
		process.env.KOFI_WEBHOOK_PAYLOAD = "";
		process.env.INPUT_KOFI_PAYLOAD = "";
		process.env.SPONSORS_FEATURED_THRESHOLD = "";
		process.env.SPONSORS_ACTIVE_WINDOW_DAYS = "";
		process.env.SPONSORS_KOFI_TIERS = "";
		process.env.SPONSORS_ALLOWED_HOSTS = "";
		process.env.SPONSORS_EXCLUDE = "";
		process.env.SPONSORS_INCLUDE_PAST = "";
		process.env.GITHUB_ACTIONS = "";
		process.env.GITHUB_EVENT_NAME = "";
		process.env.GITHUB_EVENT_PATH = "";
		process.env.GITHUB_OUTPUT = "";
		process.env.GITHUB_STEP_SUMMARY = "";
		process.env.INPUT_TOKEN = "";
		process.env["INPUT_PUSH-TOKEN"] = "";
		process.env["INPUT_DRY-RUN"] = "";
		process.env["INPUT_FEATURED-THRESHOLD"] = "";
	});

	afterEach(() => {
		process.env = savedEnv;
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads funding defaults and falls back to git remote and CI env", () => {
		const repo = makeTempDir();
		const funding = join(repo, ".github", "FUNDING.yml");
		mkdirSync(dirname(funding), { recursive: true });
		writeFileSync(
			funding,
			"github: [octocat]\nko_fi: octokofi # comment\nopen_collective: octocollective\n",
			"utf-8",
		);

		const defaults1 = sponsors.loadFundingDefaults(funding, repo);
		assert.equal(defaults1[0], "octocat");
		assert.equal(defaults1[1], "octokofi");
		assert.equal(defaults1.open_collective, "octocollective");
		assert.equal(
			sponsors.kofiProfileUrl(defaults1[1]),
			"https://ko-fi.com/octokofi",
		);

		// Without FUNDING.yml, falls back to git remote origin owner even if CI env is set
		unlinkSync(funding);
		execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
		execFileSync(
			"git",
			["remote", "add", "origin", "https://github.com/torvalds/linux.git"],
			{ cwd: repo, stdio: "ignore" },
		);
		process.env.GITHUB_REPOSITORY_OWNER = "ci-owner";
		process.env.GITHUB_REPOSITORY = "ci-owner/repo";

		const defaults2 = sponsors.loadFundingDefaults(funding, repo);
		assert.equal(defaults2[0], "torvalds");
		assert.equal(defaults2[1], "torvalds");

		// Without git remote or FUNDING.yml, falls back to GITHUB_REPOSITORY
		execFileSync("git", ["remote", "remove", "origin"], {
			cwd: repo,
			stdio: "ignore",
		});
		process.env.GITHUB_REPOSITORY_OWNER = "";
		process.env.GITHUB_REPOSITORY = "monalisa/octo-repo";

		const defaults3 = sponsors.loadFundingDefaults(funding, repo);
		assert.equal(defaults3[0], "monalisa");
		assert.equal(defaults3[1], "monalisa");
	});

	it("falls back when token lacks read:org scope and handles tier=null CTA state", async () => {
		const queriesSent = [];

		async function fakePostGraphql(query) {
			queriesSent.push(query);
			if (query.includes("... on Organization")) {
				return {
					errors: [
						{
							type: "INSUFFICIENT_SCOPES",
							message:
								"The 'login' field requires one of the following scopes: ['read:org']",
						},
					],
				};
			}
			return {
				data: {
					repositoryOwner: {
						sponsorshipsAsMaintainer: {
							totalCount: 2,
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [
								{
									isActive: true,
									tier: {
										name: "$5 a month",
										monthlyPriceInDollars: 5,
										isOneTime: false,
									},
									sponsorEntity: {
										login: "ada",
										name: "Ada Lovelace",
										avatarUrl: "",
										url: "https://github.com/ada",
									},
								},
								{
									isActive: true,
									tier: null,
									sponsorEntity: {
										login: "grace",
										name: "Grace Hopper",
										avatarUrl: "",
										url: "https://github.com/grace",
									},
								},
							],
						},
					},
				},
			};
		}

		const result = await sponsors.fetchSponsors("octocat", "ghp_test_token", {
			postGraphqlImpl: fakePostGraphql,
			fetchAvatars: false,
		});

		assert.equal(queriesSent.length, 2);
		assert.ok(queriesSent[0].includes("... on Organization"));
		assert.ok(!queriesSent[1].includes("... on Organization"));
		assert.equal(result.length, 2);
		assert.equal(result[0].login, "ada");
		assert.equal(result[0].monthly_dollars, 5);
		assert.equal(result[0].is_one_time, false);
		assert.equal(result[1].login, "grace");
		assert.equal(result[1].tier_unknown, true);

		// Even if only tier=null sponsors exist (e.g. default GITHUB_TOKEN), CTA cards flip to active
		assert.equal(sponsors.hasRecurringSponsors([result[1]]), true);
	});

	it("loads config overrides, preserves keys on write, and normalizes non-USD currencies", async () => {
		const dir = makeTempDir();
		const state = join(dir, "sponsors.json");
		writeFileSync(
			state,
			`${JSON.stringify(
				{
					featured_threshold: 10,
					active_window_days: 60,
					kofi_tiers: { "gold member": 15 },
					allowed_hosts: ["example.org"],
					sponsors: [],
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);

		const cfg = sponsors.loadSponsorsConfig(state);
		assert.equal(cfg.featured_threshold, 10);
		assert.equal(cfg.active_window_days, 60);
		assert.equal(cfg.kofi_tiers["gold member"], 15);
		assert.ok(cfg.allowed_hosts.has("example.org"));
		assert.ok(cfg.allowed_hosts.has("www.example.org"));

		assert.equal(
			await sponsors.ingestKofiPayload(
				{
					kofi_transaction_id: "tx-cfg-1",
					is_public: true,
					from_name: "Ada (@ada)",
					amount: "15.00",
					tier_name: "Gold Member",
					is_subscription_payment: true,
				},
				state,
				{ now: fixedNow, networkLookup: false },
			),
			true,
		);

		// 500 JPY (~$3.35) one-time tip converts to $3 USD instead of $500 Featured
		assert.equal(
			await sponsors.ingestKofiPayload(
				{
					kofi_transaction_id: "tx-jpy-1",
					is_public: true,
					from_name: "Ken (@ken)",
					amount: "500",
					currency: "JPY",
					is_subscription_payment: false,
				},
				state,
				{ now: fixedNow, networkLookup: false },
			),
			true,
		);

		const writtenDoc = JSON.parse(readFileSync(state, "utf-8"));
		assert.equal(writtenDoc.featured_threshold, 10);
		assert.equal(writtenDoc.active_window_days, 60);
		assert.deepEqual(writtenDoc.kofi_tiers, { "gold member": 15 });
		assert.equal(writtenDoc.sponsors.length, 2);
		assert.equal(writtenDoc.sponsors[0].monthly_dollars, 15);
		assert.equal(writtenDoc.sponsors[0].expires_at, "2027-01-04T12:00:00Z");
		assert.equal(writtenDoc.sponsors[1].login, "ken");
		assert.equal(writtenDoc.sponsors[1].monthly_dollars, 3);

		const loaded = await sponsors.loadExtraSponsors(state, null, {
			now: fixedNow,
			fetchAvatars: false,
		});
		const svg = sponsors.renderSponsorsSvg(loaded, {
			featuredThreshold: cfg.featured_threshold,
		});
		assert.ok(svg.includes("avatar-ring-featured"));
	});

	it("skips anonymous and official Ko-fi test webhook events", async () => {
		const dir = makeTempDir();
		const state = join(dir, "sponsors.json");

		for (const anonName of [
			"",
			"   ",
			"Anonymous",
			"Someone",
			"Supporter",
			"a supporter",
			"unknown",
		]) {
			const updated = await sponsors.ingestKofiPayload(
				{
					is_public: true,
					from_name: anonName,
					message: "Keep up the great work!",
					amount: "10.00",
				},
				state,
				{ now: fixedNow, networkLookup: false },
			);
			assert.equal(updated, false, `Expected '${anonName}' to be skipped`);
		}

		assert.equal(
			await sponsors.ingestKofiPayload(
				{
					kofi_transaction_id: "00000000-1111-2222-3333-444444444444",
					is_public: true,
					from_name: "Jo",
					message: "Good luck with the integration!",
					amount: "3.00",
					email: "jo.example@example.com",
				},
				state,
				{ now: fixedNow, networkLookup: false },
			),
			false,
		);

		assert.equal(
			await sponsors.ingestKofiPayload(
				{
					is_public: true,
					from_name: "Jo",
					amount: "3.00",
					email_sha256: createHash("sha256")
						.update("jo.example@example.com")
						.digest("hex"),
				},
				state,
				{ now: fixedNow, networkLookup: false },
			),
			false,
		);

		// Anonymous display name WITH an explicit @github tag in message IS ingested under the GitHub handle
		assert.equal(
			await sponsors.ingestKofiPayload(
				{
					kofi_transaction_id: "tx-real-1",
					is_public: true,
					from_name: "Anonymous",
					message: "gh: @octocat",
					amount: "5.00",
				},
				state,
				{ now: fixedNow, networkLookup: false },
			),
			true,
		);

		const loaded = await sponsors.loadExtraSponsors(state, null, {
			now: fixedNow,
			fetchAvatars: false,
		});
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0].login, "octocat");
		assert.equal(loaded[0].name, "octocat");
		assert.equal(loaded[0].url, "https://github.com/octocat");
	});

	it("preserves identity across email_sha256 renewals and one-time tips", async () => {
		const dir = makeTempDir();
		const state = join(dir, "sponsors.json");
		const adaHash = createHash("sha256").update("ada@example.com").digest("hex");

		// 1. Subscribes at $25/mo Featured tier with @ada in message
		assert.equal(
			await sponsors.ingestKofiPayload(
				{
					kofi_transaction_id: "tx-sub-1",
					is_public: true,
					from_name: "Ada Lovelace",
					message: "gh: @ada",
					amount: "25.00",
					tier_name: "$25 a month",
					is_subscription_payment: true,
					email_sha256: adaHash,
				},
				state,
				{ now: fixedNow, networkLookup: false },
			),
			true,
		);

		// 2. Month 2 renewal without social tags matches via email_sha256
		assert.equal(
			await sponsors.ingestKofiPayload(
				{
					kofi_transaction_id: "tx-sub-2",
					is_public: true,
					from_name: "Ada Lovelace",
					message: "",
					amount: "25.00",
					tier_name: "$25 a month",
					is_subscription_payment: true,
					email_sha256: adaHash,
				},
				state,
				{ now: fixedNow, networkLookup: false },
			),
			true,
		);

		// 3. Same user sends a $3 one-time tip -> does not downgrade recurring tier
		assert.equal(
			await sponsors.ingestKofiPayload(
				{
					kofi_transaction_id: "tx-tip-3",
					is_public: true,
					from_name: "ada",
					amount: "3.00",
					is_subscription_payment: false,
				},
				state,
				{ now: fixedNow, networkLookup: false },
			),
			true,
		);

		const loaded = await sponsors.loadExtraSponsors(state, null, {
			now: fixedNow,
			fetchAvatars: false,
		});
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0].is_one_time, false);
		assert.equal(loaded[0].login, "ada");
		assert.equal(loaded[0].monthly_dollars, 25);
		assert.equal(loaded[0].name, "Ada Lovelace");
		assert.equal(loaded[0].url, "https://github.com/ada");
	});

	it("ignores duplicate webhooks and sums cumulative one-time tips", async () => {
		const dir = makeTempDir();
		const state = join(dir, "sponsors.json");

		const payload = {
			kofi_transaction_id: "tx-100",
			is_public: true,
			from_name: "Linus (@torvalds)",
			amount: "10.00",
		};
		assert.equal(
			await sponsors.ingestKofiPayload(payload, state, {
				now: fixedNow,
				networkLookup: false,
			}),
			true,
		);
		assert.equal(
			await sponsors.ingestKofiPayload(payload, state, {
				now: fixedNow,
				networkLookup: false,
			}),
			false,
		);

		const payload2 = {
			kofi_transaction_id: "tx-101",
			is_public: true,
			from_name: "Linus (@torvalds)",
			amount: "20.00",
		};
		assert.equal(
			await sponsors.ingestKofiPayload(payload2, state, {
				now: fixedNow,
				networkLookup: false,
			}),
			true,
		);

		const loaded = await sponsors.loadExtraSponsors(state, null, {
			now: fixedNow,
			fetchAvatars: false,
		});
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0].is_one_time, true);
		assert.equal(loaded[0].monthly_dollars, 30);
		assert.equal(sponsors.hasRecurringSponsors(loaded), false);
	});

	it("deduplicates across platforms, sums recurring amounts, and applies overrides/exclude", () => {
		const gh = [
			new sponsors.Sponsor({
				login: "alice",
				name: "Alice Smith",
				avatar_url: "https://github.com/alice.png?size=160",
				url: "https://github.com/alice",
				monthly_dollars: 5,
				is_one_time: false,
				platform: "github",
			}),
			new sponsors.Sponsor({
				login: "bot-user",
				name: "Bot",
				url: "https://github.com/bot-user",
				monthly_dollars: 10,
				is_one_time: false,
				platform: "github",
			}),
		];
		const kofi = [
			new sponsors.Sponsor({
				login: "alice",
				name: "alice",
				avatar_url: "",
				url: "https://github.com/alice",
				monthly_dollars: 20,
				is_one_time: false,
				platform: "kofi",
			}),
		];
		const cfg = new sponsors.SponsorsConfig({
			exclude: ["bot-user"],
			overrides: {
				alice: { url: "https://alice.example.com" },
			},
		});
		const merged = sponsors.mergeSponsors(gh, kofi, { config: cfg });
		assert.equal(merged.length, 1);
		assert.equal(merged[0].login, "alice");
		assert.equal(merged[0].name, "Alice Smith");
		assert.equal(merged[0].monthly_dollars, 25);
		assert.equal(merged[0].is_one_time, false);
		assert.equal(merged[0].url, "https://alice.example.com");

		// One-time Ko-fi tip alongside a $5/mo GitHub sponsorship does NOT inflate recurring to $25/mo
		const kofiTip = [
			new sponsors.Sponsor({
				login: "alice",
				name: "alice",
				avatar_url: "",
				url: "https://github.com/alice",
				monthly_dollars: 25,
				is_one_time: true,
				platform: "kofi",
			}),
		];
		const mergedWithTip = sponsors.mergeSponsors([gh[0]], kofiTip);
		assert.equal(mergedWithTip.length, 1);
		assert.equal(mergedWithTip[0].is_one_time, false);
		assert.equal(mergedWithTip[0].monthly_dollars, 5);
	});

	it("persists state to orphan badges branch without dirtying main", () => {
		const repo = makeTempDir();
		execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "Test"], {
			cwd: repo,
			stdio: "ignore",
		});
		execFileSync("git", ["config", "user.email", "test@example.com"], {
			cwd: repo,
			stdio: "ignore",
		});

		mkdirSync(join(repo, ".github"), { recursive: true });
		const mainExtra = join(repo, ".github", "sponsors.json");
		writeFileSync(mainExtra, '{\n  "sponsors": []\n}\n', "utf-8");
		execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "init"], {
			cwd: repo,
			stdio: "ignore",
		});

		const outSvg = join(repo, "out", "sponsors.svg");
		const kofi1 = JSON.stringify({
			kofi_transaction_id: "tx-b1",
			is_public: true,
			from_name: "Grace Hopper",
			amount: "25.00",
			tier_name: "$25 a month",
			is_subscription_payment: true,
		});

		execFileSync(
			process.execPath,
			[
				SPONSORS_MJS,
				"--demo",
				"--output",
				outSvg,
				"--extra",
				mainExtra,
				"--ingest-kofi",
				kofi1,
				"--branch",
				"badges",
			],
			{ cwd: repo, stdio: "pipe" },
		);

		assert.deepEqual(JSON.parse(readFileSync(mainExtra, "utf-8")), {
			sponsors: [],
		});

		const badgesJson1 = JSON.parse(
			execFileSync("git", ["show", "refs/heads/badges:sponsors.json"], {
				cwd: repo,
				encoding: "utf-8",
			}),
		);
		assert.equal(badgesJson1.sponsors.length, 1);
		assert.equal(badgesJson1.sponsors[0].login, "Grace Hopper");

		const kofi2 = JSON.stringify({
			kofi_transaction_id: "tx-b2",
			is_public: true,
			from_name: "Alan Turing",
			amount: "5.00",
			tier_name: "$5 a month",
			is_subscription_payment: true,
		});
		execFileSync(
			process.execPath,
			[
				SPONSORS_MJS,
				"--demo",
				"--output",
				outSvg,
				"--extra",
				mainExtra,
				"--ingest-kofi",
				kofi2,
				"--branch",
				"badges",
			],
			{ cwd: repo, stdio: "pipe" },
		);

		const badgesJson2 = JSON.parse(
			execFileSync("git", ["show", "refs/heads/badges:sponsors.json"], {
				cwd: repo,
				encoding: "utf-8",
			}),
		);
		assert.deepEqual(
			badgesJson2.sponsors.map((s) => s.login),
			["Grace Hopper", "Alan Turing"],
		);
	});

	it("handles Ko-fi and GitHub Sponsors webhooks in worker.mjs with URL/token routing", async () => {
		const calls = [];
		const origFetch = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			if (url === "https://api.github.com/user") {
				return new Response(JSON.stringify({ login: "auto-owner" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			calls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
			return new Response(null, { status: 204 });
		};

		try {
			const env = {
				KOFI_VERIFICATION_TOKEN: "secret-kofi-token",
				SPONSORS_TOKEN: "ghp_test_dispatch",
				GITHUB_WEBHOOK_SECRET: "secret-gh-hmac",
			};

			// 1. Ko-fi test webhook -> 200 OK without calling GitHub
			let form = new URLSearchParams();
			form.set(
				"data",
				JSON.stringify({
					verification_token: "secret-kofi-token",
					kofi_transaction_id: "00000000-1111-2222-3333-444444444444",
					from_name: "Jo",
					email: "jo.example@example.com",
					amount: "3.00",
					is_public: true,
				}),
			);
			let res = await worker.fetch(
				new Request("https://example.workers.dev/", {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: form.toString(),
				}),
				env,
			);
			assert.equal(res.status, 200);
			assert.equal(calls.length, 0);

			// 2. Real Ko-fi webhook with auto-resolved token owner repo -> dispatches kofi-webhook
			form = new URLSearchParams();
			form.set(
				"data",
				JSON.stringify({
					verification_token: "secret-kofi-token",
					kofi_transaction_id: "real-tx-42",
					message_id: "msg-42",
					from_name: "Ada (@ada)",
					email: "ada@example.com",
					amount: "25.00",
					tier_name: "$25 a month",
					is_subscription_payment: true,
					is_public: true,
				}),
			);
			res = await worker.fetch(
				new Request("https://example.workers.dev/", {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: form.toString(),
				}),
				env,
			);
			assert.equal(res.status, 200);
			assert.equal(calls.length, 1);
			assert.equal(
				calls[0].url,
				"https://api.github.com/repos/auto-owner/auto-owner/dispatches",
			);
			assert.equal(calls[0].init.body.event_type, "kofi-webhook");
			assert.equal(calls[0].init.body.client_payload.kofi.email, undefined);
			assert.ok(calls[0].init.body.client_payload.kofi.email_sha256);

			// 3. GitHub Sponsors webhook with explicit /:owner/:repo path and valid HMAC
			const ghBody = JSON.stringify({ action: "created" });
			const sigHex = await hmacSha256Hex(env.GITHUB_WEBHOOK_SECRET, ghBody);
			res = await worker.fetch(
				new Request("https://example.workers.dev/octocat/octocat", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-github-event": "sponsorship",
						"x-hub-signature-256": `sha256=${sigHex}`,
					},
					body: ghBody,
				}),
				env,
			);
			assert.equal(res.status, 200);
			assert.equal(calls.length, 2);
			assert.equal(
				calls[1].url,
				"https://api.github.com/repos/octocat/octocat/dispatches",
			);
			assert.equal(calls[1].init.body.event_type, "sponsors-updated");
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("fetches OpenCollective sponsors, populates post-merge avatars, and renders custom tier presets", async () => {
		const ocSponsors = await sponsors.fetchOpenCollectiveSponsors(
			"octocollective",
			{
				postGraphqlImpl: async () => ({
					data: {
						collective: {
							members: {
								nodes: [
									{
										tier: { name: "Backer", frequency: "MONTHLY" },
										totalDonations: { valueInCents: 1500 },
										account: {
											slug: "ada-oc",
											name: "Ada Lovelace",
											imageUrl: "https://github.com/ada.png",
											socialLinks: [
												{ type: "GITHUB", url: "https://github.com/ada" },
											],
										},
									},
								],
							},
						},
					},
				}),
			},
		);
		assert.equal(ocSponsors.length, 1);
		assert.equal(ocSponsors[0].login, "ada");
		assert.equal(ocSponsors[0].monthly_dollars, 15);

		// Combine $15/mo OpenCollective + $10/mo GitHub -> $25/mo Featured -> fetches 128px avatar
		const ghSponsors = [
			new sponsors.Sponsor({
				login: "ada",
				name: "Ada Lovelace",
				avatar_url: "https://github.com/ada.png",
				url: "https://github.com/ada",
				monthly_dollars: 10,
				is_one_time: false,
				platform: "github",
			}),
		];
		const merged = sponsors.mergeSponsors(ghSponsors, ocSponsors);
		assert.equal(merged.length, 1);
		assert.equal(merged[0].monthly_dollars, 25);

		const requestedUrls = [];
		const populated = await sponsors.populateAvatars(merged, {
			featuredThreshold: 25,
			fetchImpl: async (url) => {
				requestedUrls.push(url);
				return new Response(Buffer.from("PNG"), {
					status: 200,
					headers: { "content-type": "image/png" },
				});
			},
		});
		assert.equal(requestedUrls.length, 1);
		assert.ok(requestedUrls[0].includes("size=128"));
		assert.ok(populated[0].avatar_data_uri.startsWith("data:image/png;base64,"));

		// Custom SponsorKit-style tier presets
		const customSvg = sponsors.renderSponsorsSvg(populated, {
			tiers: [
				{ title: "Gold Sponsors", monthlyDollars: 20, preset: "xl" },
				{ title: "Backers", monthlyDollars: 0, preset: "base" },
			],
		});
		assert.ok(customSvg.includes('width="76" height="76"'));
	});

	it("normalizes OpenCollective monthly/yearly tier amounts instead of lifetime donations", async () => {
		const oc = await sponsors.fetchOpenCollectiveSponsors("octocollective", {
			postGraphqlImpl: async () => ({
				data: {
					collective: {
						members: {
							nodes: [
								{
									tier: {
										name: "Backer",
										frequency: "MONTHLY",
										amount: { valueInCents: 500 },
									},
									// $100 lifetime over 20 months should stay $5/mo, not $100/mo
									totalDonations: { valueInCents: 10000 },
									account: {
										slug: "monthly-backer",
										name: "Monthly Backer",
										imageUrl: "",
										socialLinks: [],
									},
								},
								{
									tier: {
										name: "Annual Supporter",
										frequency: "YEARLY",
										amount: { valueInCents: 12000 },
									},
									totalDonations: { valueInCents: 24000 },
									account: {
										slug: "yearly-supporter",
										name: "Yearly Supporter",
										imageUrl: "",
										socialLinks: [],
									},
								},
							],
						},
					},
				},
			}),
		});

		assert.equal(oc.length, 2);
		assert.equal(oc[0].login, "yearly-supporter");
		assert.equal(oc[0].monthly_dollars, 10);
		assert.equal(oc[0].is_one_time, false);
		assert.equal(oc[1].login, "monthly-backer");
		assert.equal(oc[1].monthly_dollars, 5);
		assert.equal(oc[1].is_one_time, false);
	});

	it("handles astral Unicode initials/truncation, strips XML control chars, and deduplicates avatar fetches", async () => {
		const astralName = "🚀\u0007 RocketSponsorWithLongAstralName";
		const list = [
			new sponsors.Sponsor({
				login: "rocket1",
				name: astralName,
				url: "https://github.com/rocket1",
				monthly_dollars: 100,
				is_one_time: false,
			}),
			new sponsors.Sponsor({
				login: "rocket2",
				name: "Rocket Two",
				avatar_url: "https://github.com/shared.png",
				url: "https://github.com/rocket2",
				monthly_dollars: 100,
				is_one_time: false,
			}),
			new sponsors.Sponsor({
				login: "rocket3",
				name: "Rocket Three",
				avatar_url: "https://github.com/shared.png",
				url: "https://github.com/rocket3",
				monthly_dollars: 100,
				is_one_time: false,
			}),
		];

		const tiers = [{ title: "Platinum", monthlyDollars: 50, preset: "xl" }];
		const calls = [];
		const populated = await sponsors.populateAvatars(list, {
			tiers,
			fetchImpl: async (url) => {
				calls.push(url);
				return new Response(Buffer.from("PNG"), {
					status: 200,
					headers: { "content-type": "image/png" },
				});
			},
		});

		// Shared avatar URL at xl preset (160px) is fetched only once
		assert.equal(calls.length, 1);
		assert.ok(calls[0].includes("size=160"));
		assert.equal(populated[1].avatar_data_uri, populated[2].avatar_data_uri);

		const svg = sponsors.renderSponsorsSvg(populated, { tiers });
		// No lone UTF-16 surrogates or BEL (\x07) control characters
		assert.equal(svg.isWellFormed(), true);
		assert.equal(svg.includes("\x07"), false);
		assert.ok(svg.includes(">🚀</text>"));
	});

	it("preserves sibling files like coverage.json, prunes stale cards, skips no-op pushes, and retries lease races", () => {
		const remoteDir = makeTempDir();
		execFileSync("git", ["init", "--bare", remoteDir], { stdio: "ignore" });

		const repo = makeTempDir();
		execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "Test"], {
			cwd: repo,
			stdio: "ignore",
		});
		execFileSync("git", ["config", "user.email", "test@example.com"], {
			cwd: repo,
			stdio: "ignore",
		});
		execFileSync("git", ["remote", "add", "origin", remoteDir], {
			cwd: repo,
			stdio: "ignore",
		});

		// Seed remote orphan badges branch with coverage.json and a stale sponsor-polar.svg card
		const seedDir = makeTempDir();
		const covPath = join(seedDir, "coverage.json");
		const staleCard = join(seedDir, "sponsor-polar.svg");
		writeFileSync(covPath, '{"message":"98%"}\n', "utf-8");
		writeFileSync(staleCard, "<svg></svg>\n", "utf-8");
		sponsors.publishToBranch([covPath, staleCard], "badges", true, repo);

		// Publish sponsors.svg + active github/kofi cards
		const outDir = join(seedDir, "out");
		mkdirSync(outDir, { recursive: true });
		const wallPath = join(outDir, "sponsors.svg");
		const ghCard = join(outDir, "sponsor-github.svg");
		const kofiCard = join(outDir, "sponsor-kofi.svg");
		writeFileSync(wallPath, sponsors.renderEmptySvg(), "utf-8");
		writeFileSync(ghCard, sponsors.renderPlatformCardSvg("github"), "utf-8");
		writeFileSync(kofiCard, sponsors.renderPlatformCardSvg("kofi"), "utf-8");

		const remoteSha1 = sponsors.syncBranchRef("badges", repo, {
			fetchRemote: true,
		});
		sponsors.publishToBranch(
			[wallPath, ghCard, kofiCard],
			"badges",
			true,
			repo,
			{ alreadySynced: true, remoteSha: remoteSha1 },
		);

		const treeEntries = execFileSync(
			"git",
			["ls-tree", "--name-only", "refs/heads/badges"],
			{ cwd: remoteDir, encoding: "utf-8" },
		)
			.trim()
			.split(/\r?\n/)
			.sort();
		assert.deepEqual(treeEntries, [
			"coverage.json",
			"sponsor-github.svg",
			"sponsor-kofi.svg",
			"sponsors.svg",
		]);

		// Second identical publish skips redundant push when remoteSha matches tip
		const shaBeforeNoop = execFileSync(
			"git",
			["rev-parse", "refs/heads/badges"],
			{ cwd: remoteDir, encoding: "utf-8" },
		).trim();
		sponsors.publishToBranch(
			[wallPath, ghCard, kofiCard],
			"badges",
			true,
			repo,
			{ alreadySynced: true, remoteSha: shaBeforeNoop },
		);
		const shaAfterNoop = execFileSync(
			"git",
			["rev-parse", "refs/heads/badges"],
			{ cwd: remoteDir, encoding: "utf-8" },
		).trim();
		assert.equal(shaAfterNoop, shaBeforeNoop);

		// Simulate concurrent CI workflow updating coverage.json on origin/badges before sponsors pushes
		const otherClone = makeTempDir();
		execFileSync("git", ["init", "-b", "main"], {
			cwd: otherClone,
			stdio: "ignore",
		});
		execFileSync("git", ["remote", "add", "origin", remoteDir], {
			cwd: otherClone,
			stdio: "ignore",
		});
		const covPath2 = join(seedDir, "coverage-new.json");
		const covNamed = join(otherClone, "coverage.json");
		writeFileSync(covNamed, '{"message":"99%"}\n', "utf-8");
		sponsors.publishToBranch([covNamed], "badges", true, otherClone);
		void covPath2;

		// Repo still holds stale remoteSha (shaAfterNoop) and updates sponsors.svg -> lease retry preserves 99% coverage.json!
		writeFileSync(
			wallPath,
			sponsors.renderSponsorsSvg(sponsors.buildDemoSponsors()),
			"utf-8",
		);
		sponsors.publishToBranch(
			[wallPath, ghCard, kofiCard],
			"badges",
			true,
			repo,
			{ alreadySynced: true, remoteSha: shaAfterNoop },
		);

		const mergedCoverage = execFileSync(
			"git",
			["show", "refs/heads/badges:coverage.json"],
			{ cwd: remoteDir, encoding: "utf-8" },
		);
		assert.equal(mergedCoverage, '{"message":"99%"}\n');
	});

	it("supports node24 inputs, GITHUB_EVENT_PATH kofi/dry_run payloads, outputs, and step summaries", async () => {
		const repo = makeTempDir();
		execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
		mkdirSync(join(repo, ".github"), { recursive: true });
		writeFileSync(
			join(repo, ".github", "FUNDING.yml"),
			"github: octocat\nko_fi: octocat\n",
			"utf-8",
		);

		const eventFile = join(repo, "event.json");
		const outFile = join(repo, "github_output.txt");
		const summaryFile = join(repo, "step_summary.md");
		writeFileSync(
			eventFile,
			JSON.stringify({
				inputs: { dry_run: true },
				client_payload: {
					kofi: {
						kofi_transaction_id: "tx-evt-1",
						is_public: true,
						from_name: "Event Supporter (@evtsup)",
						amount: "30.00",
						tier_name: "$25 a month",
						is_subscription_payment: true,
					},
				},
			}),
			"utf-8",
		);

		process.env.GITHUB_ACTIONS = "true";
		process.env.GITHUB_EVENT_NAME = "workflow_dispatch";
		process.env.GITHUB_EVENT_PATH = eventFile;
		process.env.GITHUB_OUTPUT = outFile;
		process.env.GITHUB_STEP_SUMMARY = summaryFile;
		process.env["INPUT_FEATURED-THRESHOLD"] = "20";
		process.env["INPUT_PUSH-TOKEN"] = "ghs_push_only";

		// Empty INPUT_TOKEN falls back to INPUT_PUSH-TOKEN
		assert.equal(sponsors.resolveToken(), "ghs_push_only");
		process.env.INPUT_TOKEN = "ghp_read_user_only";
		assert.equal(sponsors.resolveToken(), "ghp_read_user_only");
		assert.deepEqual(sponsors.resolveGitTokens(), {
			primary: "ghs_push_only",
			fallback: "ghp_read_user_only",
		});

		const svgOut = join(repo, "dist", "sponsors.svg");
		await sponsors.main([
			"--demo",
			"-C",
			repo,
			"--branch",
			"badges",
			"--output",
			svgOut,
		]);

		// Dry-run wrote SVGs, outputs, and summary without creating refs/heads/badges
		assert.ok(readFileSync(svgOut, "utf-8").includes("evtsup"));
		const ghOut = readFileSync(outFile, "utf-8");
		assert.ok(ghOut.includes("dry_run=true"));
		assert.ok(ghOut.includes("sponsors_count=6"));
		assert.ok(ghOut.includes("has_recurring=true"));
		const summary = readFileSync(summaryFile, "utf-8");
		assert.ok(summary.includes("### Dry run: Sponsors SVG"));

		assert.throws(() =>
			execFileSync("git", ["rev-parse", "--verify", "refs/heads/badges"], {
				cwd: repo,
				stdio: "ignore",
			}),
		);
	});

	it("returns 400 on malformed JSON bodies and routes org sponsorship webhooks in worker.mjs", async () => {
		const calls = [];
		const origFetch = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			calls.push({ url, body: JSON.parse(init.body) });
			return new Response(null, { status: 204 });
		};
		try {
			const env = {
				KOFI_VERIFICATION_TOKEN: "secret-kofi-token",
				SPONSORS_TOKEN: "ghp_test_dispatch",
				GITHUB_WEBHOOK_SECRET: "secret-gh-hmac",
			};

			const badJsonRes = await worker.fetch(
				new Request("https://example.workers.dev/", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{not-valid-json",
				}),
				env,
			);
			assert.equal(badJsonRes.status, 400);

			const orgPayload = JSON.stringify({
				action: "created",
				sponsorship: { sponsorable: { login: "kohls-admin" } },
			});
			const sigHex = await hmacSha256Hex(env.GITHUB_WEBHOOK_SECRET, orgPayload);
			const orgRes = await worker.fetch(
				new Request("https://example.workers.dev/", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-github-event": "sponsorship",
						"x-hub-signature-256": `sha256=${sigHex}`,
					},
					body: orgPayload,
				}),
				env,
			);
			assert.equal(orgRes.status, 200);
			assert.equal(calls.length, 1);
			assert.equal(
				calls[0].url,
				"https://api.github.com/repos/kohls-admin/kohls-admin/dispatches",
			);
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});
