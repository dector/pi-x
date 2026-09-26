/**
 * Fake Gust threads for the TUI prototype.
 *
 * They describe plausible comments on the pi-x website
 * (shittycodingagent.ai) so the browser has realistic data to render while we
 * polish the layout. Replace this module with the real `gust ctl` client later;
 * the dialog only depends on `Thread` from ./types.ts.
 */

import type { Thread } from "./types.ts";

export interface FixtureSet {
	/** Where the comments supposedly came from (shown in the header). */
	site: string;
	/** Socket the real client would target, for the header/footer hint. */
	socket: string;
	threads: Thread[];
}

export function loadFixtures(): FixtureSet {
	return {
		site: "pi-x website",
		socket: "/tmp/gust-1000/9f2c.sock",
		threads: [
			{
				id: "8f21a4",
				batchId: "b-1042",
				path: "/docs/install",
				state: "submitted",
				locator: "pre > code.install",
				html: '<pre><code class="install">./install --all</code></pre>',
				text: "The install snippet still says `./install --all`, but that flag was removed. Copying it fails.",
				createdAt: "2026-09-26T14:02:00",
				updatedAt: "2026-09-26T14:02:00",
				submittedAt: "2026-09-26T14:02:00",
				messages: [],
			},
			{
				id: "6e2a44",
				batchId: "b-1042",
				path: "/extensions/subagent",
				state: "submitted",
				locator: "section#async > p",
				html: '<p>Async by default with automatic completion injection.</p>',
				text: "This paragraph contradicts the table right above it: the table says blocking only.",
				createdAt: "2026-09-26T14:03:00",
				updatedAt: "2026-09-26T14:03:00",
				submittedAt: "2026-09-26T14:03:00",
				messages: [],
			},
			{
				id: "2b77e0",
				batchId: "b-1041",
				path: "/extensions",
				state: "seen",
				locator: "table.ext-table",
				html: '<table class="ext-table"><thead>…</thead></table>',
				text: "On narrow screens the extension table overflows the card and gets clipped. Stack it or let it scroll.",
				createdAt: "2026-09-26T13:40:00",
				updatedAt: "2026-09-26T13:44:00",
				submittedAt: "2026-09-26T13:40:00",
				seenAt: "2026-09-26T13:44:00",
				messages: [],
			},
			{
				id: "9d13c5",
				batchId: "b-1039",
				path: "/",
				state: "review",
				locator: "p.hero-sub",
				html: '<p class="hero-sub">for shittycodingagent.ai</p>',
				text: "Hero subtitle reads 'for shittycodingagent.ai' — should that link to the site?",
				createdAt: "2026-09-26T11:10:00",
				updatedAt: "2026-09-26T11:22:00",
				submittedAt: "2026-09-26T11:10:00",
				seenAt: "2026-09-26T11:12:00",
				messages: [
					{
						id: "m-1",
						author: "agent",
						text: "Wrapped the subtitle in a link to https://shittycodingagent.ai and kept the styling.",
						createdAt: "2026-09-26T11:22:00",
					},
				],
			},
			{
				id: "77e1b3",
				batchId: "b-1038",
				path: "/docs/faq",
				state: "review",
				locator: "details:nth-child(3) > summary",
				html: "<summary>Is Windows supported?</summary>",
				text: "The FAQ says 'not supported yet' but the support table lists Windows as beta.",
				createdAt: "2026-09-26T10:05:00",
				updatedAt: "2026-09-26T10:31:00",
				submittedAt: "2026-09-26T10:05:00",
				seenAt: "2026-09-26T10:08:00",
				messages: [
					{
						id: "m-2",
						author: "agent",
						text: "Changed the FAQ to 'beta (WSL only)' to match the table.",
						createdAt: "2026-09-26T10:31:00",
					},
					{
						id: "m-3",
						author: "human",
						text: "Nice. Can we also link 'beta' to the tracking issue?",
						createdAt: "2026-09-26T10:36:00",
					},
				],
			},
			{
				id: "4a0f92",
				path: "/themes",
				state: "created",
				locator: "ul.theme-list > li:nth-child(2) > code",
				html: "<code>night-dark</code>",
				text: "Add a copy button next to each theme name so people can paste it into settings.json.",
				createdAt: "2026-09-26T09:58:00",
				updatedAt: "2026-09-26T09:58:00",
				messages: [],
			},
			{
				id: "1c5de8",
				batchId: "b-1036",
				path: "/extensions/skills",
				state: "done",
				locator: "a[href*='dector/skills']",
				html: '<a href="https://github.com/dector/skills">skills repo</a>',
				text: "The 'skills repo' link 404s — it points at the wrong branch.",
				createdAt: "2026-09-25T18:20:00",
				updatedAt: "2026-09-25T18:47:00",
				submittedAt: "2026-09-25T18:20:00",
				seenAt: "2026-09-25T18:24:00",
				finishedAt: "2026-09-25T18:47:00",
				messages: [
					{
						id: "m-4",
						author: "agent",
						text: "Fixed the URL to point at the default branch and verified it returns 200.",
						createdAt: "2026-09-25T18:44:00",
					},
					{
						id: "m-5",
						author: "human",
						text: "Confirmed, closing.",
						createdAt: "2026-09-25T18:47:00",
					},
				],
			},
		],
	};
}
