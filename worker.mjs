/**
 * Cloudflare Worker: Ko-fi & GitHub Sponsors Webhook -> GitHub repository_dispatch Relay
 *
 * Target repository resolution order:
 *   1. URL path (`POST https://<worker>.workers.dev/<owner>/<repo>`)
 *   2. `GITHUB_REPO` environment variable (`<owner>/<repo>`)
 *   3. Webhook `sponsorable.login` (`<login>/<login>`, for GitHub Sponsors webhooks)
 *   4. Authenticated token owner's profile repository (`<login>/<login>`)
 *
 * Worker secrets (`npx wrangler secret put <NAME>`):
 *   - SPONSORS_TOKEN (or GITHUB_TOKEN / GITHUB_DISPATCH_TOKEN): GitHub PAT with `Contents: Read and write`
 *   - KOFI_VERIFICATION_TOKEN (optional): Verification token from https://ko-fi.com/manage/webhooks
 *   - GITHUB_WEBHOOK_SECRET (optional): Webhook secret from https://github.com/sponsors/<owner>/dashboard/webhooks
 */

const KOFI_TEST_TRANSACTION_ID = "00000000-1111-2222-3333-444444444444";
const KOFI_TEST_EMAIL = "jo.example@example.com";

let cachedTokenRepo = { token: "", repo: "" };

export async function sha256Hex(input) {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function hmacSha256Hex(secret, message) {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function timingSafeEqual(a, b) {
	if (typeof a !== "string" || typeof b !== "string") return false;
	const enc = new TextEncoder();
	const aBytes = enc.encode(a);
	const bBytes = enc.encode(b);
	if (aBytes.byteLength !== bBytes.byteLength) return false;
	let diff = 0;
	for (let i = 0; i < aBytes.byteLength; i++) {
		diff |= aBytes[i] ^ bBytes[i];
	}
	return diff === 0;
}

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function resolveDispatchToken(env) {
	return (
		env.SPONSORS_TOKEN ||
		env.GITHUB_TOKEN ||
		env.GITHUB_DISPATCH_TOKEN ||
		""
	).trim();
}

export async function resolveTargetRepo(
	request,
	env,
	token,
	fallbackOwner = "",
) {
	try {
		const url = new URL(request.url);
		const pathMatch = url.pathname.match(
			/^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?$/,
		);
		if (pathMatch) {
			return pathMatch[1];
		}
	} catch {
		// Fall through to env or token owner lookup
	}

	const envRepo = (env.GITHUB_REPO || "").trim();
	if (envRepo) {
		return envRepo;
	}

	const cleanFallback = String(fallbackOwner || "").trim();
	if (/^[A-Za-z0-9_.-]+$/.test(cleanFallback)) {
		return `${cleanFallback}/${cleanFallback}`;
	}

	if (!token) {
		return "";
	}
	if (cachedTokenRepo.token === token && cachedTokenRepo.repo) {
		return cachedTokenRepo.repo;
	}

	try {
		const userRes = await fetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "sponsors-webhook-worker/1.0",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (userRes.ok) {
			const data = await userRes.json();
			const login = typeof data?.login === "string" ? data.login.trim() : "";
			if (login) {
				const repo = `${login}/${login}`;
				cachedTokenRepo = { token, repo };
				return repo;
			}
		}
	} catch {
		// Ignore network lookup failure; caller returns 500 if unresolved
	}
	return "";
}

async function dispatchToGitHub(
	request,
	env,
	eventType,
	clientPayload,
	{ fallbackOwner = "" } = {},
) {
	const token = resolveDispatchToken(env);
	if (!token) {
		return new Response(
			"Missing SPONSORS_TOKEN (or GITHUB_TOKEN / GITHUB_DISPATCH_TOKEN) secret on Worker",
			{ status: 500 },
		);
	}
	const repo = await resolveTargetRepo(request, env, token, fallbackOwner);
	if (!repo) {
		return new Response(
			"Could not resolve target GitHub repository; set GITHUB_REPO or post to /<owner>/<repo>",
			{ status: 500 },
		);
	}

	const ghResponse = await fetch(
		`https://api.github.com/repos/${repo}/dispatches`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				"User-Agent": "sponsors-webhook-worker/1.0",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			body: JSON.stringify({
				event_type: eventType,
				client_payload: clientPayload,
			}),
		},
	);

	if (!ghResponse.ok) {
		const errText = await ghResponse.text();
		return new Response(
			`GitHub dispatch failed (${ghResponse.status}): ${errText}`,
			{ status: 502 },
		);
	}

	return jsonResponse({ ok: true, dispatched: eventType, repo });
}

async function handleGitHubWebhook(request, env, ghEvent) {
	if (!env.GITHUB_WEBHOOK_SECRET) {
		return new Response("GitHub webhook secret not configured", {
			status: 401,
		});
	}

	const sigHeader = request.headers.get("x-hub-signature-256") || "";
	const rawBody = await request.text();
	const expectedSig = `sha256=${await hmacSha256Hex(env.GITHUB_WEBHOOK_SECRET, rawBody)}`;

	if (!timingSafeEqual(sigHeader, expectedSig)) {
		return new Response("Invalid GitHub webhook signature", { status: 401 });
	}

	if (ghEvent === "ping") {
		return jsonResponse({ ok: true, pong: true });
	}

	if (ghEvent !== "sponsorship") {
		return jsonResponse({ ok: true, ignored: ghEvent });
	}

	let payload = {};
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return new Response("Invalid JSON payload", { status: 400 });
	}

	const sponsorableLogin =
		typeof payload?.sponsorship?.sponsorable?.login === "string"
			? payload.sponsorship.sponsorable.login
			: "";

	return dispatchToGitHub(
		request,
		env,
		"sponsors-updated",
		{ action: payload.action || "" },
		{ fallbackOwner: sponsorableLogin },
	);
}

async function extractKofiPayloadJson(request) {
	const contentType = request.headers.get("content-type") || "";
	try {
		if (
			contentType.includes("application/x-www-form-urlencoded") ||
			contentType.includes("multipart/form-data")
		) {
			const form = await request.formData();
			const rawData = form.get("data");
			if (typeof rawData !== "string") return { status: "missing" };
			const parsed = JSON.parse(rawData);
			if (!parsed || typeof parsed !== "object") return { status: "invalid" };
			return { status: "ok", payload: parsed };
		}
		if (contentType.includes("application/json")) {
			const body = await request.json();
			if (!body || typeof body !== "object") return { status: "missing" };
			const parsed =
				typeof body.data === "string" ? JSON.parse(body.data) : body;
			if (!parsed || typeof parsed !== "object") return { status: "invalid" };
			return { status: "ok", payload: parsed };
		}
	} catch (err) {
		return {
			status: "invalid",
			error: err instanceof Error ? err.message : String(err),
		};
	}
	return { status: "missing" };
}

export default {
	async fetch(request, env) {
		if (request.method === "GET") {
			return jsonResponse({ ok: true, service: "sponsors-webhook" });
		}
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const ghEvent = request.headers.get("x-github-event");
		if (ghEvent) {
			return handleGitHubWebhook(request, env, ghEvent);
		}

		const parsedKofi = await extractKofiPayloadJson(request);
		if (parsedKofi.status === "missing") {
			return new Response("Missing Ko-fi data payload", { status: 400 });
		}
		if (parsedKofi.status !== "ok") {
			return new Response("Invalid JSON in Ko-fi payload", { status: 400 });
		}
		const { payload } = parsedKofi;

		if (
			!env.KOFI_VERIFICATION_TOKEN ||
			!timingSafeEqual(
				payload.verification_token || "",
				env.KOFI_VERIFICATION_TOKEN,
			)
		) {
			return new Response("Invalid verification token", { status: 401 });
		}

		const emailRaw =
			typeof payload.email === "string"
				? payload.email.trim().toLowerCase()
				: "";
		const txId =
			typeof payload.kofi_transaction_id === "string"
				? payload.kofi_transaction_id.trim()
				: "";

		if (txId === KOFI_TEST_TRANSACTION_ID || emailRaw === KOFI_TEST_EMAIL) {
			return jsonResponse({ ok: true, test: true });
		}

		if (payload.is_public === false) {
			return jsonResponse({ ok: true, skipped: "private" });
		}

		const emailSha256 = emailRaw ? await sha256Hex(emailRaw) : "";

		const sanitized = {
			message_id: payload.message_id || "",
			kofi_transaction_id: txId,
			timestamp: payload.timestamp || new Date().toISOString(),
			type: payload.type || "Donation",
			is_public: payload.is_public !== false,
			from_name: payload.from_name || "",
			message: payload.message || "",
			amount: payload.amount || "0",
			currency: payload.currency || "USD",
			is_subscription_payment: Boolean(payload.is_subscription_payment),
			is_first_subscription_payment: Boolean(
				payload.is_first_subscription_payment,
			),
			tier_name: payload.tier_name || "",
			email_sha256: emailSha256,
		};

		return dispatchToGitHub(request, env, "kofi-webhook", { kofi: sanitized });
	},
};
