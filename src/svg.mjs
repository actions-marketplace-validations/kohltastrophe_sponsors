import {
	FEATURED_THRESHOLD,
	normalizePlatform,
	PLATFORMS,
	TIER_PRESETS,
} from "./config.mjs";

export const SVG_STYLE = `  <style>
    .font {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .tier-heading {
      fill: #656d76;
      font-size: 12px;
      font-weight: 500;
    }
    .sponsor-name {
      fill: #1f2328;
      font-size: 12px;
      font-weight: 500;
    }
    .sponsor-login {
      fill: #656d76;
      font-size: 11px;
      font-weight: 400;
    }
    .avatar-ring {
      fill: none;
      stroke: #d0d7de;
      stroke-width: 1.25;
    }
    .avatar-ring-featured {
      fill: none;
      stroke: #bf3989;
      stroke-width: 1.5;
      stroke-opacity: 0.55;
    }
    .avatar-fallback {
      fill: #f6f8fa;
    }
    .avatar-initial {
      fill: #57606a;
      font-weight: 600;
    }
    .cta-card {
      fill: #f6f8fa;
      stroke: #d0d7de;
      stroke-width: 1;
    }
    .cta-title {
      fill: #1f2328;
      font-size: 13px;
      font-weight: 600;
    }
    .cta-sub {
      fill: #656d76;
      font-size: 11.5px;
      font-weight: 400;
    }
    .cta-slot-github {
      fill: #bf3989;
      fill-opacity: 0.1;
      stroke: #bf3989;
      stroke-width: 1.25;
      stroke-dasharray: 3 3;
    }
    .cta-icon-github {
      fill: #bf3989;
    }
    .cta-pill-github {
      fill: #bf3989;
      fill-opacity: 0.1;
      stroke: #bf3989;
      stroke-width: 1;
      stroke-opacity: 0.35;
    }
    .cta-pill-text-github {
      fill: #bf3989;
      font-size: 12px;
      font-weight: 600;
    }
    .cta-slot-kofi {
      fill: #e04f4c;
      fill-opacity: 0.1;
      stroke: #e04f4c;
      stroke-width: 1.25;
      stroke-dasharray: 3 3;
    }
    .cta-icon-kofi {
      fill: #e04f4c;
    }
    .cta-pill-kofi {
      fill: #e04f4c;
      fill-opacity: 0.1;
      stroke: #e04f4c;
      stroke-width: 1;
      stroke-opacity: 0.35;
    }
    .cta-pill-text-kofi {
      fill: #e04f4c;
      font-size: 12px;
      font-weight: 600;
    }
    @media (prefers-color-scheme: dark) {
      .tier-heading { fill: #8b949e; }
      .sponsor-name { fill: #e6edf3; }
      .sponsor-login { fill: #8b949e; }
      .avatar-ring { stroke: #30363d; }
      .avatar-ring-featured { stroke: #db61a2; stroke-opacity: 0.65; }
      .avatar-fallback { fill: #161b22; }
      .avatar-initial { fill: #8b949e; }
      .cta-card { fill: #161b22; stroke: #30363d; }
      .cta-title { fill: #e6edf3; }
      .cta-sub { fill: #8b949e; }
      .cta-slot-github { fill: #db61a2; fill-opacity: 0.14; stroke: #db61a2; }
      .cta-icon-github { fill: #db61a2; }
      .cta-pill-github { fill: #db61a2; fill-opacity: 0.14; stroke: #db61a2; stroke-opacity: 0.45; }
      .cta-pill-text-github { fill: #db61a2; }
      .cta-slot-kofi { fill: #ff7875; fill-opacity: 0.14; stroke: #ff7875; }
      .cta-icon-kofi { fill: #ff7875; }
      .cta-pill-kofi { fill: #ff7875; fill-opacity: 0.14; stroke: #ff7875; stroke-opacity: 0.45; }
      .cta-pill-text-kofi { fill: #ff7875; }
    }
  </style>`;

const EXTRA_PLATFORM_THEMES = Object.freeze({
	opencollective: { light: "#1f87ff", dark: "#58a6ff" },
	polar: { light: "#0062ff", dark: "#58a6ff" },
	patreon: { light: "#d94625", dark: "#ff8066" },
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips XML 1.0 illegal control characters
const INVALID_XML_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;

export function sortSponsors(sponsors) {
	return [...sponsors].sort((a, b) => {
		const aPast = a.is_past ? 1 : 0;
		const bPast = b.is_past ? 1 : 0;
		if (aPast !== bPast) return aPast - bPast;

		const aOneTime = a.is_one_time ? 1 : 0;
		const bOneTime = b.is_one_time ? 1 : 0;
		if (aOneTime !== bOneTime) return aOneTime - bOneTime;

		if (b.monthly_dollars !== a.monthly_dollars) {
			return b.monthly_dollars - a.monthly_dollars;
		}
		const loginCmp = a.login.toLowerCase().localeCompare(b.login.toLowerCase());
		if (loginCmp !== 0) return loginCmp;
		return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
	});
}

/** Escapes XML metacharacters and strips disallowed XML 1.0 control characters. */
export function escapeXml(text) {
	return String(text ?? "")
		.replace(INVALID_XML_CHARS_RE, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#x27;");
}

function firstInitial(text) {
	const cps = Array.from(String(text || "").trim());
	return cps.length > 0 ? cps[0].toUpperCase() : "";
}

/** Truncates `text` by Unicode code points so astral characters never leave lone surrogates. */
export function truncateLabel(text, maxChars) {
	const cps = Array.from(String(text || ""));
	if (cps.length <= maxChars) return cps.join("");
	return `${cps
		.slice(0, Math.max(0, maxChars - 1))
		.join("")
		.trimEnd()}…`;
}

export function renderStyle() {
	return SVG_STYLE;
}

function resolvePlatformCardCopy(normPlatform, hasMonthlySponsors, cx, cy) {
	if (normPlatform === "github") {
		const heartPath =
			"M7.655 14.916v-.001h-.002l-.006-.003-.018-.01a22.066 22.066 0 0 1-3.744-2.584" +
			"C2.045 10.731 0 8.35 0 5.5 0 2.836 2.086 1 4.25 1 5.797 1 7.153 1.802 8 3.02" +
			" 8.847 1.802 10.203 1 11.75 1 13.914 1 16 2.836 16 5.5c0 2.85-2.044 5.231-3.886 6.818" +
			"a22.094 22.094 0 0 1-3.433 2.414 7.152 7.152 0 0 1-.31.17l-.018.01-.008.004a.75.75 0 0 1-.69 0Z";
		return {
			ariaLabel: "Sponsor on GitHub Sponsors",
			title: hasMonthlySponsors
				? "GitHub Sponsors"
				: "Become the first sponsor",
			subtitle: hasMonthlySponsors
				? "Monthly & one-time tiers"
				: "Get featured across every repo",
			pillLabel: "Sponsor",
			iconEl: `  <path class="cta-icon-github" transform="translate(${(cx - 6.8).toFixed(1)}, ${(cy - 6.5).toFixed(1)}) scale(0.85)" d="${heartPath}" />`,
		};
	}
	if (normPlatform === "kofi") {
		const cupPath =
			"M1 3.5A1 1 0 0 1 2 2.5h9.5a1 1 0 0 1 1 1V4.5h1.25a2.75 2.75 0 0 1 0 5.5H12.4" +
			"A4.5 4.5 0 0 1 8 13.75H5.5A4.5 4.5 0 0 1 1 9.25V3.5Z" +
			"M12.5 6v2.5h1.25a1.25 1.25 0 0 0 0-2.5H12.5Z" +
			"M6.75 10.9c.38-.24 2.85-1.85 2.85-3.7 0-1.05-.8-1.82-1.75-1.82-.48 0-.86.24-1.1.6" +
			"-.24-.36-.62-.6-1.1-.6-.95 0-1.75.77-1.75 1.82 0 1.85 2.47 3.46 2.85 3.7Z";
		return {
			ariaLabel: "Support on Ko-fi",
			title: hasMonthlySponsors ? "Ko-fi" : "Become the first on Ko-fi",
			subtitle: hasMonthlySponsors
				? "0% fee tips & memberships"
				: "0% fee · tag @github to list avatar",
			pillLabel: "Support",
			iconEl: `  <path class="cta-icon-kofi" fill-rule="evenodd" transform="translate(${(cx - 6.75).toFixed(2)}, ${(cy - 8.125).toFixed(3)})" d="${cupPath}" />`,
		};
	}
	if (normPlatform === "opencollective") {
		return {
			ariaLabel: "Back on OpenCollective",
			title: hasMonthlySponsors ? "OpenCollective" : "Back on OpenCollective",
			subtitle: "Transparent open-source backing",
			pillLabel: "Contribute",
			iconEl: `  <circle class="cta-icon-opencollective" cx="${cx}" cy="${cy}" r="6" />`,
		};
	}
	if (normPlatform === "polar") {
		return {
			ariaLabel: "Subscribe on Polar",
			title: "Polar",
			subtitle: "Open-source funding & tiers",
			pillLabel: "Sponsor",
			iconEl: `  <circle class="cta-icon-polar" cx="${cx}" cy="${cy}" r="6" />`,
		};
	}
	if (normPlatform === "patreon") {
		return {
			ariaLabel: "Support on Patreon",
			title: "Patreon",
			subtitle: "Monthly memberships",
			pillLabel: "Become a patron",
			iconEl: `  <circle class="cta-icon-patreon" cx="${cx}" cy="${cy}" r="6" />`,
		};
	}
	throw new Error(`Unsupported platform '${normPlatform}'`);
}

export function renderPlatformCardSvg(
	platform,
	{ hasMonthlySponsors = false } = {},
) {
	const width = hasMonthlySponsors ? 304 : 340;
	const height = hasMonthlySponsors ? 56 : 60;
	const cx = hasMonthlySponsors ? 28 : 30;
	const cy = hasMonthlySponsors ? 28 : 30;
	const pillX = hasMonthlySponsors ? 222 : 256;
	const pillY = hasMonthlySponsors ? 15 : 17;
	const pillW = hasMonthlySponsors ? 70 : 72;
	const titleY = hasMonthlySponsors ? "24" : "25.5";
	const subY = hasMonthlySponsors ? "40" : "42";
	const pillTextY = hasMonthlySponsors ? "32.2" : "34.2";
	const pillCenterX = (pillX + pillW / 2).toFixed(1);

	const theme = normalizePlatform(platform);
	const { ariaLabel, title, subtitle, pillLabel, iconEl } =
		resolvePlatformCardCopy(theme, hasMonthlySponsors, cx, cy);

	const textX = cx + 28;
	const extraColors = EXTRA_PLATFORM_THEMES[theme];
	const styleBlock = extraColors
		? SVG_STYLE.replace(
				"    @media (prefers-color-scheme: dark) {",
				`    .cta-slot-${theme} { fill: ${extraColors.light}; fill-opacity: 0.1; stroke: ${extraColors.light}; stroke-width: 1.25; stroke-dasharray: 3 3; }\n    .cta-icon-${theme} { fill: ${extraColors.light}; }\n    .cta-pill-${theme} { fill: ${extraColors.light}; fill-opacity: 0.1; stroke: ${extraColors.light}; stroke-width: 1; stroke-opacity: 0.35; }\n    .cta-pill-text-${theme} { fill: ${extraColors.light}; font-size: 12px; font-weight: 600; }\n    @media (prefers-color-scheme: dark) {\n      .cta-slot-${theme} { fill: ${extraColors.dark}; fill-opacity: 0.14; stroke: ${extraColors.dark}; }\n      .cta-icon-${theme} { fill: ${extraColors.dark}; }\n      .cta-pill-${theme} { fill: ${extraColors.dark}; fill-opacity: 0.14; stroke: ${extraColors.dark}; stroke-opacity: 0.45; }\n      .cta-pill-text-${theme} { fill: ${extraColors.dark}; }`,
			)
		: SVG_STYLE;
	const lines = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(ariaLabel)}">`,
		styleBlock,
		`  <rect class="cta-card" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" />`,
		`  <circle class="cta-slot-${theme}" cx="${cx}" cy="${cy}" r="16" pathLength="96" />`,
		iconEl,
		`  <text class="font cta-title" x="${textX}" y="${titleY}">${escapeXml(title)}</text>`,
		`  <text class="font cta-sub" x="${textX}" y="${subY}">${escapeXml(subtitle)}</text>`,
		`  <rect class="cta-pill-${theme}" x="${pillX}" y="${pillY}" width="${pillW}" height="26" rx="13" />`,
		`  <text class="font cta-pill-text-${theme}" x="${pillCenterX}" y="${pillTextY}" text-anchor="middle">${escapeXml(pillLabel)}</text>`,
		"</svg>",
		"",
	];
	return lines.join("\n");
}

export function renderEmptySvg() {
	return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="1" height="1" role="img" aria-label="Sponsors"></svg>\n';
}

export function renderTierSection(
	sponsors,
	{
		startY,
		width,
		avatarSize,
		cellW,
		cellH,
		cols,
		featured,
		heading,
		clipPrefix,
		maxChars = null,
	},
) {
	const defs = [];
	const body = [];
	let y = startY;

	if (heading) {
		body.push(
			`  <text class="font tier-heading" x="${(width / 2).toFixed(1)}" y="${y + 14}" text-anchor="middle">${escapeXml(heading)}</text>`,
		);
		y += 28;
	}

	const rows = Math.ceil(sponsors.length / cols);
	const r = avatarSize / 2;
	const labelMax = maxChars ?? (featured ? 14 : 12);

	for (let rowIdx = 0; rowIdx < rows; rowIdx++) {
		const rowItems = sponsors.slice(rowIdx * cols, (rowIdx + 1) * cols);
		const rowStartX = (width - rowItems.length * cellW) / 2;

		for (let colIdx = 0; colIdx < rowItems.length; colIdx++) {
			const sponsor = rowItems[colIdx];
			const idx = rowIdx * cols + colIdx;
			const clipId = `${clipPrefix}-${idx}`;
			const cx = rowStartX + colIdx * cellW + cellW / 2;
			const cy = y + r;

			defs.push(
				`    <clipPath id="${clipId}"><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" /></clipPath>`,
			);

			const escLogin = escapeXml(sponsor.login);
			const escName = escapeXml(sponsor.name);
			const escUrl = escapeXml(sponsor.url);
			const tooltip =
				sponsor.platform === PLATFORMS.KOFI &&
				sponsor.login.toLowerCase() === sponsor.name.toLowerCase()
					? `${escName} (Ko-fi)`
					: `${escName} (@${escLogin})`;

			body.push(
				`  <a href="${escUrl}" target="_blank" rel="noopener noreferrer">`,
			);
			body.push(`    <title>${tooltip}</title>`);

			if (sponsor.avatar_data_uri) {
				body.push(
					`    <image x="${(cx - r).toFixed(1)}" y="${(cy - r).toFixed(1)}" width="${avatarSize}" height="${avatarSize}" href="${sponsor.avatar_data_uri}" clip-path="url(#${clipId})" />`,
				);
			} else {
				const initial = escapeXml(firstInitial(sponsor.name || sponsor.login));
				const fontPx = Math.trunc(avatarSize * 0.4);
				body.push(
					`    <circle class="avatar-fallback" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" />`,
				);
				body.push(
					`    <text class="font avatar-initial" x="${cx.toFixed(1)}" y="${(cy + fontPx * 0.35).toFixed(1)}" font-size="${fontPx}" text-anchor="middle">${initial}</text>`,
				);
			}

			const ringClass = featured ? "avatar-ring-featured" : "avatar-ring";
			body.push(
				`    <circle class="${ringClass}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" />`,
			);

			const labelText = truncateLabel(
				featured ? sponsor.name : sponsor.login,
				labelMax,
			);
			const labelClass = featured ? "sponsor-name" : "sponsor-login";
			body.push(
				`    <text class="font ${labelClass}" x="${cx.toFixed(1)}" y="${(cy + r + 16).toFixed(1)}" text-anchor="middle">${escapeXml(labelText)}</text>`,
			);
			body.push("  </a>");
		}

		y += cellH;
	}

	return [defs, body, y];
}

function doesSponsorMatchTier(sponsor, tier) {
	if (tier.monthlyDollars < 0) return sponsor.is_past;
	if (sponsor.is_past) return false;
	if (tier.isOneTime === true) {
		return sponsor.is_one_time && sponsor.monthly_dollars >= tier.monthlyDollars;
	}
	if (tier.isOneTime === false) {
		return (
			!sponsor.is_one_time && sponsor.monthly_dollars >= tier.monthlyDollars
		);
	}
	if (tier.monthlyDollars > 0 && sponsor.is_one_time) return false;
	return sponsor.monthly_dollars >= tier.monthlyDollars;
}

export function resolveTierGroups(
	sponsors,
	{ featuredThreshold = FEATURED_THRESHOLD, tiers = null } = {},
) {
	if (!Array.isArray(tiers) || tiers.length === 0) {
		const featured = sponsors.filter(
			(s) =>
				!s.is_past && !s.is_one_time && s.monthly_dollars >= featuredThreshold,
		);
		const standard = sponsors.filter(
			(s) =>
				!s.is_past && (s.is_one_time || s.monthly_dollars < featuredThreshold),
		);
		const past = sponsors.filter((s) => s.is_past);
		const groups = [];
		if (featured.length > 0) {
			groups.push({
				title: "Featured sponsors",
				items: featured,
				preset: TIER_PRESETS.lg,
				clipPrefix: "feat",
			});
		}
		if (standard.length > 0) {
			groups.push({
				title: "Sponsors",
				items: standard,
				preset: TIER_PRESETS.base,
				clipPrefix: "std",
			});
		}
		if (past.length > 0) {
			groups.push({
				title: "Past sponsors",
				items: past,
				preset: TIER_PRESETS.xs,
				clipPrefix: "past",
			});
		}
		return groups;
	}

	const remaining = [...sponsors];
	const sortedTiers = [...tiers]
		.map((t, idx) => {
			const presetObj =
				typeof t.preset === "string" && TIER_PRESETS[t.preset]
					? TIER_PRESETS[t.preset]
					: TIER_PRESETS.base;
			return {
				title: t.title || `Tier ${idx + 1}`,
				monthlyDollars: t.monthlyDollars ?? t.monthly_dollars ?? 0,
				isOneTime: t.isOneTime ?? t.is_one_time ?? null,
				preset: {
					...presetObj,
					...(t.avatar_size ? { avatar_size: Number(t.avatar_size) } : {}),
					...(t.featured != null ? { featured: Boolean(t.featured) } : {}),
				},
				clipPrefix: `tier${idx}`,
			};
		})
		.sort((a, b) => b.monthlyDollars - a.monthlyDollars);

	const groups = [];
	for (const tier of sortedTiers) {
		const matched = [];
		for (let i = remaining.length - 1; i >= 0; i--) {
			if (doesSponsorMatchTier(remaining[i], tier)) {
				matched.unshift(remaining[i]);
				remaining.splice(i, 1);
			}
		}
		if (matched.length > 0) {
			groups.push({
				title: tier.title,
				items: sortSponsors(matched),
				preset: tier.preset,
				clipPrefix: tier.clipPrefix,
			});
		}
	}
	return groups;
}

export function renderSponsorsSvg(
	sponsors,
	{ featuredThreshold = FEATURED_THRESHOLD, tiers = null } = {},
) {
	if (!sponsors || sponsors.length === 0) {
		return renderEmptySvg();
	}

	const groups = resolveTierGroups(sponsors, { featuredThreshold, tiers });
	if (groups.length === 0) {
		return renderEmptySvg();
	}

	const multiGroup = groups.length > 1;
	let contentW = multiGroup ? 160 : 0;
	for (const g of groups) {
		const w = Math.min(g.items.length, g.preset.cols) * g.preset.cell_w;
		if (w > contentW) contentW = w;
	}
	const width = Math.max(contentW + 8, 680);

	const defs = [];
	const body = [];
	let y = 18;

	for (let i = 0; i < groups.length; i++) {
		const g = groups[i];
		const [gDefs, gBody, nextY] = renderTierSection(g.items, {
			startY: y,
			width,
			avatarSize: g.preset.avatar_size,
			cellW: g.preset.cell_w,
			cellH: g.preset.cell_h,
			cols: g.preset.cols,
			featured: g.preset.featured,
			heading: multiGroup ? g.title : null,
			clipPrefix: g.clipPrefix,
			maxChars: g.preset.max_chars,
		});
		defs.push(...gDefs);
		body.push(...gBody);
		y = nextY;
		if (i + 1 < groups.length) {
			y += 10;
		}
	}

	const height = y + 4;
	const lines = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Sponsors">`,
		SVG_STYLE,
	];
	if (defs.length > 0) {
		lines.push("  <defs>");
		lines.push(...defs);
		lines.push("  </defs>");
	}
	lines.push(...body);
	lines.push("</svg>");
	lines.push("");
	return lines.join("\n");
}
