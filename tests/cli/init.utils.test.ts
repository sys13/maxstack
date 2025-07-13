import { describe, expect, it } from "vitest";

import { toKebabCase } from "../../src/bin/commands/init.utils.js";

describe("toKebabCase", () => {
	it("converts simple words to kebab-case", () => {
		expect(toKebabCase("hello world")).toBe("hello-world");
		expect(toKebabCase("My Cool Project")).toBe("my-cool-project");
	});

	it("removes special characters", () => {
		expect(toKebabCase("Hello World!!!")).toBe("hello-world");
		expect(toKebabCase("Project@Name#")).toBe("projectname");
		expect(toKebabCase("Test_Project*")).toBe("test-project");
	});

	it("handles multiple spaces and hyphens", () => {
		expect(toKebabCase("  Spaced   Out  ")).toBe("spaced-out");
		expect(toKebabCase("Already-Kebab---Case")).toBe("already-kebab-case");
		expect(toKebabCase("Multiple   ---   Hyphens")).toBe("multiple-hyphens");
	});

	it("handles edge cases", () => {
		expect(toKebabCase("")).toBe("");
		expect(toKebabCase("   ")).toBe("");
		expect(toKebabCase("a")).toBe("a");
		expect(toKebabCase("A")).toBe("a");
	});

	it("removes leading and trailing hyphens", () => {
		expect(toKebabCase("-leading-hyphen")).toBe("leading-hyphen");
		expect(toKebabCase("trailing-hyphen-")).toBe("trailing-hyphen");
		expect(toKebabCase("-both-ends-")).toBe("both-ends");
	});

	it("preserves numbers", () => {
		expect(toKebabCase("Project 123")).toBe("project-123");
		expect(toKebabCase("Version2.0")).toBe("version20");
		expect(toKebabCase("My App v1.2.3")).toBe("my-app-v123");
	});

	it("handles uppercase text", () => {
		expect(toKebabCase("UPPERCASE_TEXT")).toBe("uppercase-text");
		expect(toKebabCase("MixedCASE")).toBe("mixedcase");
		expect(toKebabCase("CamelCaseProject")).toBe("camelcaseproject");
	});
});
