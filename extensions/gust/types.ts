/**
 * Shared domain types for the Gust comment browser.
 *
 * These mirror the JSON that `gust ctl comments` prints, so the fake fixtures
 * used by the TUI prototype can later be replaced with real `ctl` output
 * without touching the dialog.
 */

/** Workflow state of a Gust thread. */
export type ThreadState = "created" | "submitted" | "seen" | "review" | "done";

/** Who wrote a thread message. */
export type Author = "human" | "agent";

/** One reply inside a thread. */
export interface ThreadMessage {
	id: string;
	author: Author;
	text: string;
	createdAt: string;
}

/**
 * A Gust comment thread: the root human request plus its replies.
 *
 * `text` is the root comment; `messages` holds replies (mirrors the Gust
 * `Comment` shape where the root is a field and `messages` is the thread).
 */
export interface Thread {
	id: string;
	batchId?: string;
	path: string;
	text: string;
	html: string;
	locator: string;
	state: ThreadState;
	messages: ThreadMessage[];
	createdAt: string;
	updatedAt: string;
	submittedAt?: string;
	seenAt?: string;
	finishedAt?: string;
}
