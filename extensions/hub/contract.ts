export const HUB_CHANNELS = {
	register: "hub:register",
	unregister: "hub:unregister",
	ask: "hub:ask",
	request: "hub:request",
	reply: "hub:reply",
	answer: "hub:answer",
} as const;

export const HUB_PERMISSIONS = {
	shell: "perm:shell",
	io: "perm:io",
	net: "perm:net",
	agent: "perm:agent",
} as const;

export type PermissionAction = "allow" | "confirm" | "block";

export type CapRequest = {
	what: string;
	data: Record<string, unknown>;
};

export type CapResult = {
	what: string;
	action: PermissionAction;
	reason?: string;
};

export type HubRegisterPayload = {
	id: string;
	caps: { provide: string[] };
};

export type HubUnregisterPayload = {
	id: string;
};

export type HubAskPayload = {
	id: string;
	from?: string;
	ctx?: unknown;
	cap: CapRequest[];
};

export type HubRequestPayload = HubAskPayload & {
	targets: string[];
};

export type HubReplyPayload = {
	id: string;
	from?: string;
	results: CapResult[];
};

export type HubAnswerPayload = {
	id: string;
	results: CapResult[];
};
