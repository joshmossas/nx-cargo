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
		.filter(manifest => {
			return fs.existsSync(manifest.filepath);
		})
		.sort((a, b) => a.depth - b.depth);
	fs.writeFileSync("__cargo-manifests.json", JSON.stringify(sortedManifests));
	for (const { filepath } of sortedManifests) {
		if (seenManifestPaths.has(filepath)) {
			continue;
		}

		try {
			const metadata = getCargoMetadata(path.dirname(filepath));

			if (metadata.packages) {
				for (const pkg of metadata.packages) {
					seenManifestPaths.add(path.resolve(pkg.manifest_path));
				}
			}

			const workspaceDeps = processWorkspaceMetadata(ctx, metadata);
			allDependencies.push(...workspaceDeps);
		} catch (e) {
			// Log to stderr so it shows up in the terminal even if Nx masks the error
			process.stderr.write(`[nx-rust] Error processing ${filepath}\n`);
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

	fs.writeFileSync("__cargo-projects.json", JSON.stringify(result));

	return result;
}

/**
 * Executes 'cargo metadata'.
 */
function getCargoMetadata(cwd: string): CargoMetadata {
	const availableMemory = os.freemem();
	const cmd = "cargo metadata --format-version=1";
	const metadata = cp.execSync(cmd, {
		encoding: "utf8",
		maxBuffer: availableMemory,
		cwd: cwd,
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
	});

	return JSON.parse(metadata);
}
