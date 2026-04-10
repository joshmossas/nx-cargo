import {
	ProjectConfiguration,
	CreateDependenciesContext as Context,
	RawProjectGraphDependency as GraphDependency,
	DependencyType,
} from "@nx/devkit";
import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

/** * Type Definitions for Cargo Metadata
 */
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
	dependencies: unknown[];
	manifest_path: string;
}

interface CargoMetadata {
	packages: CargoPackage[];
	workspace_members: CargoId[];
	resolve: {
		nodes: ResolveNode[];
	};
	workspace_root: string;
}

interface ResolveNode {
	id: CargoId;
	dependencies: CargoId[];
}

type WithReq<T, K extends keyof T> = Omit<T, K> & {
	[Key in K]-?: Exclude<T[Key], null | undefined>;
};

/**
 * Main Nx Dependency Creator
 */
export function createDependencies(_: unknown, ctx: Context): GraphDependency[] {
	const allDependencies: GraphDependency[] = [];
	const seenManifestPaths = new Set<string>();

	// 1. Identify and sort manifests by depth (shallowest first)
	// This ensures we hit workspace roots before hitting their members.
	const sortedManifests = Object.values(ctx.projects)
		.map(project => {
			const filepath = path.resolve(ctx.workspaceRoot, project.root, "Cargo.toml");
			const depth = filepath.split(path.sep).length;
			return { filepath, depth };
		})
		.filter(manifest => fs.existsSync(manifest.filepath))
		.sort((a, b) => a.depth - b.depth);

	for (const { filepath } of sortedManifests) {
		// 2. Skip if this manifest was already included in a previously processed workspace
		if (seenManifestPaths.has(filepath)) {
			continue;
		}

		try {
			const metadata = getCargoMetadata(path.dirname(filepath));

			// 3. Mark every package in this metadata as "seen" to avoid redundant calls
			for (const pkg of metadata.packages) {
				seenManifestPaths.add(path.resolve(pkg.manifest_path));
			}

			// 4. Extract dependencies from this specific workspace/crate
			const workspaceDeps = processWorkspaceMetadata(ctx, metadata);
			allDependencies.push(...workspaceDeps);
		} catch (e) {
			console.warn(
				`[nx-rust] Skipping ${filepath} due to error:`,
				e instanceof Error ? e.message : e
			);
		}
	}

	return allDependencies;
}

/**
 * Orchestrates the mapping between Cargo's internal resolve graph and Nx projects
 */
function processWorkspaceMetadata(
	ctx: Context,
	metadata: CargoMetadata
): GraphDependency[] {
	const { packages, resolve } = metadata;

	const workspacePackages = new Map<CargoId, CargoPackage>();
	for (const pkg of packages) {
		workspacePackages.set(pkg.id, pkg);
	}

	const nxData = mapCargoProjects(ctx, workspacePackages);

	return (resolve?.nodes ?? [])
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

/**
 * Maps Cargo Packages to Nx Project Configurations based on their root directories
 */
function mapCargoProjects(ctx: Context, packages: Map<CargoId, CargoPackage>) {
	const result = new Map<CargoId, WithReq<ProjectConfiguration, "name">>();

	for (const [cargoId, cargoPackage] of packages) {
		const manifestDir = path.dirname(cargoPackage.manifest_path);
		const projectDir = path
			.relative(ctx.workspaceRoot, manifestDir)
			.replace(/\\/g, "/");

		const found = Object.entries(ctx.projects).find(
			([, config]) => config.root === projectDir
		);

		if (found) {
			const [projectName, projectConfig] = found;
			result.set(cargoId, {
				...projectConfig,
				name: projectName,
			});
		}
	}

	return result;
}

/**
 * Executes 'cargo metadata'.
 * Uses --no-deps because we only care about internal workspace dependencies.
 */
function getCargoMetadata(cwd: string): CargoMetadata {
	const availableMemory = os.freemem();
	const cmd = "cargo metadata --format-version=1 --no-deps";
	console.info(`[nx-json] Executing: "${cmd}"`);
	const metadata = cp.execSync("cargo metadata --format-version=1 --no-deps", {
		encoding: "utf8",
		maxBuffer: availableMemory,
		cwd: cwd,
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
	});

	return JSON.parse(metadata);
}
