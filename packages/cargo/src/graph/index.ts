import {
	CreateDependenciesContext as Context,
	RawProjectGraphDependency as GraphDependency,
	DependencyType,
} from "@nx/devkit";
import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { globby } from "globby";

//// "cargo metadata stuff" ////

/**
 * looks something like this "path+file://path/to/project#0.1.1"
 * see https://doc.rust-lang.org/cargo/commands/cargo-metadata.html#json-format
 * and https://doc.rust-lang.org/cargo/reference/pkgid-spec.html
 */
export type CargoPkgId = string;
export interface CargoPackage {
	name: string;
	version: string;
	id: CargoPkgId;
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

export interface CargoDependency {
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

export interface CargoMetadata {
	packages: CargoPackage[];
	workspace_members: CargoPkgId[];
	workspace_default_members: CargoPkgId[];
	resolve: {
		nodes: ResolveNode[];
		root: unknown;
	};
	target_directory: string;
	version: number;
	workspace_root: string;
	metadata: unknown | null;
}

export interface ResolveNode {
	id: CargoPkgId;
	dependencies: CargoPkgId[];
}

export interface CargoProject {
	/**
	 * Path to the project directory
	 */
	projectDir: string;
	/**
	 * Path to the Cargo.toml file
	 */
	manifestPath: string;
	/**
	 * List of project directories that this project depends on
	 */
	dependencyProjectDirs: string[];
}

export interface NxCargoOptions {
	/**
	 * Will skip cargo errors
	 */
	ignoreCargoErrors?: boolean;
}

export async function createDependencies(
	options: NxCargoOptions | undefined,
	ctx: Context
): Promise<GraphDependency[]> {
	const skipRustGraph =
		process.env["NX_SKIP_GRAPH"] ?? process.env["NX_SKIP_RUST_GRAPH"] ?? "false";
	if (["true", "TRUE", "1", true].includes(skipRustGraph)) {
		return [];
	}
	// key is the project directory
	const projectPackages = new Map<string, CargoProject>();
	const seenDirs = new Set<string>();
	const cargoTomls = (
		await globby("**/Cargo.toml", {
			absolute: true,
			ignore: [
				"node_modules",
				"**/node_modules",
				".vscode",
				"target",
				"**/target",
				".dart_tool",
				"**/.dart_tool",
				".gradle",
				"**/.gradle",
				"**/.*/**",
				"**/build",
				"**/dist",
			],
		})
	).sort((left, right) => {
		// make it so configs deeper in the file tree are read last since they are more likely to be
		// part of a workspace meaning we can skip reading them
		const leftDepth = left.split(path.sep).length;
		const rightDepth = right.split(path.sep).length;
		return leftDepth <= rightDepth ? -1 : 1;
	});

	for (const cargoToml of cargoTomls) {
		const dirname = path.dirname(cargoToml);
		let isProjectDir: boolean;
		try {
			isProjectDir = fs.existsSync(path.resolve(dirname, "project.json"));
		} catch (_) {
			isProjectDir = false;
		}
		if (!isProjectDir) continue;
		if (seenDirs.has(dirname)) continue;
		let meta: CargoMetadata;
		try {
			meta = getCargoMetadata(dirname);
		} catch (err) {
			if (options?.ignoreCargoErrors) {
				console.warn(`[nx-cargo] Error reading cargo toml. ${err}`);
				continue;
			}
			throw err;
		}
		seenDirs.add(dirname);
		if (isWorkspaceMetadata(meta)) {
			// create a "project" just in case the workspace itself is a project
			const workspaceProject: CargoProject = {
				projectDir: dirname,
				manifestPath: path.resolve(dirname, "Cargo.toml"),
				dependencyProjectDirs: [],
			};
			// workspace projects depend on all their members
			// I've chosen NOT to make "workspace" projects dependent on the actual local packages listed in
			// dependencies in the Cargo.toml. Instead they will only be dependent on their members.
			//
			// This is because the individual members will already be depending on those dependencies if imported
			// So adding those to the workspace dependency array would be redundant and it muddies up the dependency graph
			for (const member of meta.workspace_members) {
				const [projectDir, _] = dirsFromCargoPkgId(member);
				if (!projectDir) continue;
				if (workspaceProject.dependencyProjectDirs.includes(projectDir)) {
					continue;
				}
				workspaceProject.dependencyProjectDirs.push(projectDir);
			}
			// for workspaces "packages" includes all the workspace members
			for (const pkg of meta.packages) {
				const [projectDir, manifestPath] = dirsFromCargoPkgId(pkg.id);
				if (!projectDir) continue;
				seenDirs.add(projectDir);
				// collect the dependencies of the member
				const dependencyDirs: string[] = [];
				for (const dep of pkg.dependencies) {
					if (typeof dep.path !== "string") continue;
					dependencyDirs.push(path.resolve(dep.path));
				}
				// add the workspace member to the project map
				projectPackages.set(projectDir, {
					projectDir: projectDir,
					manifestPath: manifestPath,
					dependencyProjectDirs: dependencyDirs,
				});
			}
			projectPackages.set(dirname, workspaceProject);
			continue;
		}
		const dependencyDirs: string[] = [];
		// for non-workspaces "packages" includes all the dependencies of that crate
		for (const pkg of meta.packages) {
			const [projectDir, _] = dirsFromCargoPkgId(pkg.id);
			if (!projectDir) continue;
			dependencyDirs.push(projectDir);
		}
		projectPackages.set(dirname, {
			projectDir: dirname,
			manifestPath: path.resolve(dirname, "Cargo.toml"),
			dependencyProjectDirs: dependencyDirs,
		});
	}
	return translateDependenciesForNx(ctx, projectPackages);
}

export function isWorkspaceMetadata(input: CargoMetadata) {
	if (input.workspace_members.length > 1) return true;
	const [projectRoot, _] = dirsFromCargoPkgId(input.workspace_members[0]!);
	return projectRoot !== input.workspace_root;
}

function getCargoMetadata(cwd: string): CargoMetadata {
	let availableMemory: number | undefined;
	try {
		availableMemory = os.freemem();
	} catch (err) {
		// do nothing
	}
	let metadata = cp.execSync("cargo metadata --format-version=1", {
		encoding: "utf8",
		maxBuffer: availableMemory,
		cwd: cwd,
	});
	return JSON.parse(metadata);
}

function getProjectNameAndSourceFileByDir(
	ctx: Context,
	dir: string
): [string, string] | [undefined, undefined] {
	for (const [key, val] of Object.entries(ctx.projects)) {
		const relativeDir = path.relative(ctx.workspaceRoot, dir);
		if (val.root === relativeDir) {
			const name = val.name ?? key;
			const sourceFile = path.relative(
				ctx.workspaceRoot,
				path.resolve(dir, "Cargo.toml")
			);
			return [name, sourceFile];
		}
	}
	return [undefined, undefined];
}

export function translateDependenciesForNx(
	ctx: Context,
	packages: Map<CargoPkgId, CargoProject>
): GraphDependency[] {
	const result: GraphDependency[] = [];
	for (let [_, cargoProject] of packages) {
		const [projectName, sourceFile] = getProjectNameAndSourceFileByDir(
			ctx,
			cargoProject.projectDir
		);
		if (!projectName) continue;
		for (const dep of cargoProject.dependencyProjectDirs) {
			const [depProjectName, _] = getProjectNameAndSourceFileByDir(ctx, dep);
			if (!depProjectName) continue;
			result.push({
				source: projectName,
				sourceFile: sourceFile,
				target: depProjectName,
				type: DependencyType.static,
			});
		}
	}

	return result;
}

/**
 * @returns ["{{project-dir}}", "{{manifest-dir}}"] or [undefined, undefined]
 */
function dirsFromCargoPkgId(
	input: CargoPkgId
): [string, string] | [undefined, undefined] {
	if (!input.startsWith("file://") && !input.startsWith("path+file://")) {
		return [undefined, undefined];
	}
	let [trimmed] = input.split("#");
	if (typeof trimmed !== "string" || trimmed.length === 0) {
		return [undefined, undefined];
	}
	if (trimmed.startsWith("file://")) {
		trimmed = trimmed.replace("file://", "");
	} else if (trimmed.startsWith("path+file://")) {
		trimmed = trimmed.replace("path+file://", "");
	}
	const projectDir = trimmed.split("/").join(path.sep);
	const manifestPath = path.resolve(trimmed, "Cargo.toml");
	return [projectDir, manifestPath];
}
