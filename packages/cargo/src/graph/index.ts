import {
	ProjectConfiguration,
	CreateDependenciesContext as Context,
	RawProjectGraphDependency as GraphDependency,
	DependencyType,
} from "@nx/devkit";
import fs from "node:fs";
import * as cp from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

type VersionNumber = `${number}.${number}.${number}`;
type PackageVersion = `${string}@${VersionNumber}` | VersionNumber;
type CargoId = `${"registry" | "path"}+${
	| "http"
	| "https"
	| "file"}://${string}#${PackageVersion}`;

interface CargoPackage {
	name: string;
	version: string;
	id: CargoId;
	license: string;
	license_file: string | null;
	description: string;
	source: string | null;
	dependencies: CargoDependency[];
	targets: unknown; // TODO
	features: Record<string, string[]>;
	manifest_path: string;
	metadata: unknown | null; // TODO
	publish: unknown | null; // TODO
	authors: string[];
	categories: string[];
	keywords: string[];
	readme: string | null;
	repository: string | null;
	homepage: string | null;
	documentation: string | null;
	edition: string;
	links: unknown | null; // TODO
	default_run: unknown | null; // TODO
	rust_version: string;
}

interface CargoDependency {
	name: string;
	source: string | null;
	req: string;
	kind: "build" | "dev" | null;
	rename: string | null;
	optional: boolean;
	uses_default_features: boolean;
	features: string[];
	target: string | null;
	registry: string | null;
	path?: string;
}

interface CargoMetadata {
	packages: CargoPackage[];
	workspace_members: CargoId[];
	workspace_default_members: CargoId[];
	resolve: {
		nodes: ResolveNode[];
		root: unknown;
	};
	target_directory: string;
	version: number;
	workspace_root: string;
	metadata: unknown | null;
}

interface ResolveNode {
	id: CargoId;
	dependencies: CargoId[];
}
export function createDependencies(_: unknown, ctx: Context): GraphDependency[] {
	const allDependencies: GraphDependency[] = [];
	const processedWorkspaceRoots = new Set<string>();

	// 1. Identify all potential Cargo workspaces/projects in the Nx graph
	const cargoConfigPaths = Object.values(ctx.projects)
		.map(p => path.join(ctx.workspaceRoot, p.root, "Cargo.toml"))
		.filter(p => fs.existsSync(p));

	for (const configPath of cargoConfigPaths) {
		const configDir = path.dirname(configPath);

		// 2. Get metadata for this specific workspace
		const metadata = getCargoMetadata(configDir);

		// 3. Skip if we've already processed this workspace (via another member)
		if (processedWorkspaceRoots.has(metadata.workspace_root)) {
			continue;
		}
		processedWorkspaceRoots.add(metadata.workspace_root);

		// 4. Process this workspace's internal dependencies
		const workspaceDeps = processWorkspaceMetadata(ctx, metadata);
		allDependencies.push(...workspaceDeps);
	}

	return allDependencies;
}

function processWorkspaceMetadata(
	ctx: Context,
	metadata: CargoMetadata
): GraphDependency[] {
	const {
		packages,
		workspace_members: cargoWsMembers,
		resolve: cargoResolve,
	} = metadata;

	const workspacePackages = new Map<CargoId, CargoPackage>();
	for (const id of cargoWsMembers) {
		const pkg = packages.find(p => p.id === id);
		if (pkg) workspacePackages.set(id, pkg);
	}

	const nxData = mapCargoProjects(ctx, workspacePackages);

	return cargoResolve.nodes
		.filter(({ id }) => nxData.has(id))
		.flatMap(({ id: sourceId, dependencies }) => {
			const sourceProject = nxData.get(sourceId)!;
			const cargoPackage = workspacePackages.get(sourceId)!;
			const sourceManifest = path
				.relative(ctx.workspaceRoot, cargoPackage.manifest_path)
				.replace(/\\/g, "/");

			return dependencies
				.filter(depId => nxData.has(depId))
				.map(depId => ({
					source: sourceProject.name,
					target: nxData.get(depId)!.name,
					type: DependencyType.static,
					sourceFile: sourceManifest,
				}));
		});
}

function getCargoMetadata(cwd: string): CargoMetadata {
	const availableMemory = os.freemem();
	// Run cargo metadata from the specific directory of the Cargo.toml
	const metadata = cp.execSync("cargo metadata --format-version=1", {
		encoding: "utf8",
		maxBuffer: availableMemory,
		cwd: cwd, // Crucial: run in the workspace directory
	});

	return JSON.parse(metadata);
}

type WithReq<T, K extends keyof T> = Omit<T, K> & {
	[Key in K]-?: Exclude<T[Key], null | undefined>;
};

function mapCargoProjects(ctx: Context, packages: Map<CargoId, CargoPackage>) {
	let result = new Map<CargoId, WithReq<ProjectConfiguration, "name">>();

	for (let [cargoId, cargoPackage] of packages) {
		if (!cargoPackage.manifest_path) {
			throw new Error("Expected cargo package's `manifest_path` to exist");
		}

		let manifestDir = path.dirname(cargoPackage.manifest_path);
		let projectDir = path
			.relative(ctx.workspaceRoot, manifestDir)
			.replace(/\\/g, "/");

		let found = Object.entries(ctx.projects).find(
			([, config]) => config.root === projectDir
		);

		if (found) {
			let [projectName, projectConfig] = found;

			result.set(cargoId, {
				...projectConfig,
				name: projectName,
			});
		}
	}

	return result;
}
