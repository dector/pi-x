import { DecisionTreeService } from "../core/service";
import { FileDecisionTreePersistence, resolveProjectRoot, resolveStoragePaths } from "../persistence";

export type DecisionTreePiContext = {
	projectRoot: string;
	decisionsPath: string;
	service: DecisionTreeService;
};

export async function createDecisionTreePiContext(cwd: string): Promise<DecisionTreePiContext> {
	const projectRoot = await resolveProjectRoot(cwd);
	const paths = resolveStoragePaths(projectRoot);
	return {
		projectRoot,
		decisionsPath: paths.decisionsDir,
		service: new DecisionTreeService(new FileDecisionTreePersistence()),
	};
}
