import {
	CreateDependenciesContext,
	DependencyType,
	RawProjectGraphDependency,
} from "@nx/devkit";

import {
	CargoDependency,
	CargoMetadata,
	CargoPackage,
	CargoProject,
	isWorkspaceMetadata,
	translateDependenciesForNx,
} from "./index";

function cargoPackageFactory(
	name: string,
	id: string,
	dependencies: CargoDependency[] = []
): CargoPackage {
	return {
		name: name,
		version: "",
		id: id,
		license: "",
		license_file: null,
		description: "",
		source: null,
		dependencies: dependencies,
		targets: [],
		features: {},
		manifest_path: "",
		metadata: undefined,
		publish: undefined,
		authors: [],
		categories: [],
		keywords: [],
		readme: null,
		repository: null,
		homepage: null,
		documentation: null,
		edition: "",
		links: undefined,
		default_run: undefined,
		rust_version: "",
	};
}

describe("isWorkspaceMetadata()", () => {
	const memberFoo = "path+file:///workspace/foo";
	const memberBar = "path+file:///workspace/bar";
	const memberBaz = "file:///workspace/baz";
	test("workspace with multiple members", () => {
		const meta: CargoMetadata = {
			packages: [
				cargoPackageFactory("foo", memberFoo),
				cargoPackageFactory("bar", memberBar),
				cargoPackageFactory("baz", memberBaz),
			],
			workspace_members: [memberFoo, memberBar, memberBaz],
			workspace_default_members: [memberFoo, memberBar, memberBaz],
			resolve: {
				nodes: [],
				root: undefined,
			},
			target_directory: "/workspace/target",
			version: 0,
			workspace_root: "/workspace",
			metadata: undefined,
		};
		expect(isWorkspaceMetadata(meta)).toBe(true);
	});
	test("workspace with one member", () => {
		const meta: CargoMetadata = {
			packages: [cargoPackageFactory("foo", memberFoo)],
			workspace_members: [memberFoo],
			workspace_default_members: [memberFoo],
			resolve: {
				nodes: [],
				root: undefined,
			},
			target_directory: "/workspace/target",
			version: 0,
			workspace_root: "/workspace",
			metadata: undefined,
		};
		expect(isWorkspaceMetadata(meta)).toBe(true);
	});
	test("non-workspace", () => {
		const meta: CargoMetadata = {
			packages: [cargoPackageFactory("foo", memberFoo)],
			workspace_members: [memberFoo],
			workspace_default_members: [memberFoo],
			resolve: {
				nodes: [],
				root: undefined,
			},
			target_directory: "/workspace/foo/target",
			version: 0,
			workspace_root: "/workspace/foo",
			metadata: undefined,
		};
		expect(isWorkspaceMetadata(meta)).toBe(false);
	});
});

test("translateDependenciesForNx", () => {
	const ctx: CreateDependenciesContext = {
		externalNodes: {},
		projects: {
			foo: {
				root: "libs/foo",
			},
			bar: {
				name: "bar",
				root: "libs/bar",
			},
			randomName: {
				name: "randomName",
				root: "libs/baz",
			},
		},
		nxJsonConfiguration: {},
		fileMap: {
			nonProjectFiles: [],
			projectFileMap: {},
		},
		filesToProcess: {
			nonProjectFiles: [],
			projectFileMap: {},
		},
		workspaceRoot: "/superapp",
	};
	const cargoProjects = new Map<string, CargoProject>();
	cargoProjects.set("/superapp/libs/foo", {
		projectDir: "/superapp/libs/foo",
		manifestPath: "/superapp/libs/foo/Cargo.toml",
		dependencyProjectDirs: [],
	});
	cargoProjects.set("/superapp/libs/bar", {
		projectDir: "/superapp/libs/bar",
		manifestPath: "/superapp/libs/bar/Cargo.toml",
		dependencyProjectDirs: [],
	});
	cargoProjects.set("/superapp/libs/baz", {
		projectDir: "/superapp/libs/baz",
		manifestPath: "/superapp/libs/baz/Cargo.toml",
		dependencyProjectDirs: [],
	});
	let result = translateDependenciesForNx(ctx, cargoProjects);
	expect(result.length).toBe(0);
	cargoProjects.set("/superapp/libs/foo", {
		projectDir: "/superapp/libs/foo",
		manifestPath: "/superapp/libs/foo/Cargo.toml",
		dependencyProjectDirs: ["/superapp/libs/bar", "/superapp/libs/baz"],
	});
	cargoProjects.set("/superapp/libs/bar", {
		projectDir: "/superapp/libs/bar",
		manifestPath: "/superapp/libs/bar/Cargo.toml",
		dependencyProjectDirs: ["/superapp/libs/baz"],
	});
	result = translateDependenciesForNx(ctx, cargoProjects);
	expect(result.length).toBe(3);
	const expectedResult: RawProjectGraphDependency[] = [
		{
			source: "foo",
			sourceFile: "libs/foo/Cargo.toml",
			target: "bar",
			type: DependencyType.static,
		},
		{
			source: "foo",
			sourceFile: "libs/foo/Cargo.toml",
			target: "randomName",
			type: DependencyType.static,
		},
		{
			source: "bar",
			sourceFile: "libs/bar/Cargo.toml",
			target: "randomName",
			type: DependencyType.static,
		},
	];
	expect(result).toStrictEqual(expectedResult);
});
