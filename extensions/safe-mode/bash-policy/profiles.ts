import type { BashMatcher } from "./types";
import { parseErrorMatcher } from "./matchers/structural/parse-error";
import { redirectionsMatcher } from "./matchers/structural/redirections";
import { substitutionsMatcher } from "./matchers/structural/substitutions";
import { unknownCommandMatcher } from "./matchers/structural/unknown-command";
import { writeLikeCommandMatcher } from "./matchers/structural/write-command";
import { readOnlyAllowMatcher } from "./matchers/structural/read-only-allow";
import { defaultConfirmMatcher } from "./matchers/structural/default-confirm";

const BASE_MATCHERS: readonly BashMatcher[] = [
	parseErrorMatcher,
	redirectionsMatcher,
	substitutionsMatcher,
	unknownCommandMatcher,
	writeLikeCommandMatcher,
	readOnlyAllowMatcher,
	defaultConfirmMatcher,
];

export function matchersForProfile(profile: "reader" | "smart"): readonly BashMatcher[] {
	if (profile === "reader" || profile === "smart") return BASE_MATCHERS;
	return BASE_MATCHERS;
}
